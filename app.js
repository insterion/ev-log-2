'use strict';
/* EV Log 2.0 v1.6.0
 * Keep the SAME IndexedDB database and version as v0.1. Charges remain unchanged.
 * Store costs, garage and comparison preferences in the existing "meta" store.
 * No cloud requests, analytics, external JS or account.
 */
const DB_NAME = 'evlog2-local';
const DB_VERSION = 1;
const STORE_CHARGES = 'charges';
const STORE_META = 'meta';
const EXPENSE_PREFIX = 'expense:';
const GARAGE_KEY = 'garage:profile';
const COMPARISON_KEY = 'comparison:settings';
const BACKUP_FORMAT = 'ev-log-2';
const PRICE_HINTS = { public:0.56, rapid:0.79, home:0.24, work:0 };
const TYPE_NAMES = { public:'Публично AC', rapid:'Бързо DC', home:'Домашно', work:'Служебно / друго' };
const COST_NAMES = { insurance:'Insurance', mot:'MOT', tax:'Road tax / VED', service:'Service', tyres:'Гуми', repair:'Ремонт', parking:'Паркинг', cleaning:'Миене / грижа', fuel:'Гориво (ICE)', other:'Друго' };
const DUE_NAMES = {mot:'MOT',insurance:'Insurance',tax:'Road tax / VED',service:'Service'};
const $ = id => document.getElementById(id);
const money = value => '£' + Number(value).toFixed(2);
const roundPence = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const chargeTotal = entry => roundPence(entry.kwh * entry.pricePerKwh);
const today = () => localDate(new Date());
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `ev2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const monthName = key => new Intl.DateTimeFormat('bg-BG',{month:'long',year:'numeric'}).format(new Date(`${key}-01T12:00:00`));
const fmtDate = value => new Intl.DateTimeFormat('bg-BG',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(`${value}T12:00:00`));
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dateValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  return !Number.isNaN(d.getTime()) && localDate(d) === value;
}
function numeric(value) { return typeof value === 'number' && Number.isFinite(value); }
function textField(value,max,label) {
  if (typeof value !== 'string' || value.length > max) throw Error(`Невалидно поле: ${label}.`);
}
function optionalOdo(value) {
  return value === null || (numeric(value) && Number.isInteger(value) && value >= 0 && value <= 9999999);
}
function validId(value) { return typeof value === 'string' && value.length >= 3 && value.length <= 120; }
function sortNewest(a,b) { return b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id); }
let db;
let charges = [];
let expenses = [];
let garage = emptyGarage();
let comparison = defaultComparison();
let comparisonStored = false;
let chargeEditingId = null;
let suggestedTariff = null;
let expenseEditingId = null;
let toastTimeout;
let installEvent = null;
// Dashboard month selection is UI-only and is not stored in IndexedDB.
let overviewMonth = today().slice(0,7);
// Read-only analysis controls. Nothing is stored in IndexedDB or added to backups.
let customRange = {from:localDate(new Date(new Date().getFullYear(),new Date().getMonth(),1)),to:today()};


function defaultComparison() {
  return {distanceMiles:100,efficiencyMiKwh:3.5,iceMpgUk:45,fuelPriceLitre:1.50,priceMode:'history',manualPriceKwh:0.56};
}
function emptyGarageExtras() {
  return {vin:'',tyresInstalledDate:'',tyresOdometerMiles:null,tyresNote:'',battery12vDate:'',cabinFilterDate:'',wipersDate:'',nextServiceOdometerMiles:null};
}
function emptyGarage() {
  return {make:'',model:'',year:null,registration:'',odometerMiles:null,notes:'',due:{mot:'',insurance:'',tax:'',service:''},extras:emptyGarageExtras()};
}
function notify(message,error=false) {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'show error' : 'show';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {el.className='';},4700);
}
function element(tag,className,text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}
function openDb() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE_CHARGES)) {
        const store = database.createObjectStore(STORE_CHARGES,{keyPath:'id'});
        store.createIndex('date','date');
      }
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META,{keyPath:'key'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || Error('Не мога да отворя локалната база.'));
    req.onblocked = () => reject(Error('Затвори останалите прозорци на EV Log 2.0 и опитай отново.'));
  });
}
function readDb() {
  return new Promise((resolve,reject) => {
    const tx = db.transaction([STORE_CHARGES,STORE_META],'readonly');
    const chargeRequest = tx.objectStore(STORE_CHARGES).getAll();
    const metaRequest = tx.objectStore(STORE_META).getAll();
    tx.oncomplete = () => resolve({charges:chargeRequest.result || [],meta:metaRequest.result || []});
    tx.onerror = () => reject(tx.error || Error('Не мога да прочета записите.'));
    tx.onabort = () => reject(tx.error || Error('Четенето е прекъснато.'));
  });
}
function transaction(stores,callback) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(stores,'readwrite');
    try { callback(tx); } catch (error) {tx.abort();reject(error);return;}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || Error('Неуспешен запис в базата.'));
    tx.onabort = () => reject(tx.error || Error('Записът е прекъснат.'));
  });
}
async function saveCharge(record,remove=false) {
  await transaction([STORE_CHARGES],tx => {
    const store = tx.objectStore(STORE_CHARGES);
    if (remove) store.delete(record.id); else store.put(record);
  });
}
async function saveExpense(record,remove=false) {
  await transaction([STORE_META],tx => {
    const store = tx.objectStore(STORE_META);
    if (remove) store.delete(EXPENSE_PREFIX+record.id);
    else store.put({key:EXPENSE_PREFIX+record.id,value:record});
  });
}
async function saveGarage(profile) {
  await transaction([STORE_META],tx => tx.objectStore(STORE_META).put({key:GARAGE_KEY,value:profile}));
}
async function refresh() {
  const data = await readDb();
  charges = data.charges.sort(sortNewest);
  expenses = data.meta.filter(item => typeof item.key === 'string' && item.key.startsWith(EXPENSE_PREFIX) && item.value).map(item => item.value).sort(sortNewest);
  garage = data.meta.find(item => item.key === GARAGE_KEY)?.value || emptyGarage();
  const savedComparison = data.meta.find(item => item.key === COMPARISON_KEY);
  comparisonStored = !!savedComparison;
  comparison = savedComparison ? validateComparison(savedComparison.value) : defaultComparison();
  renderAll();
  renderChargeHelpers();
}
function navigate(view) {
  document.querySelectorAll('.view').forEach(section => {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle('active',active);
  });
  document.querySelectorAll('.nav-item').forEach(button => {
    const active = button.dataset.go === view;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  window.scrollTo(0,0);
}
function validateCharge(raw) {
  if (!raw || typeof raw !== 'object') throw Error('Невалидно зареждане.');
  if (!dateValid(raw.date)) throw Error('Въведи валидна дата за зареждането.');
  if (!Object.hasOwn(TYPE_NAMES,raw.type)) throw Error('Невалиден тип зареждане.');
  if (!numeric(raw.kwh) || raw.kwh <= 0 || raw.kwh > 1000) throw Error('kWh трябва да е от 0 до 1000.');
  if (!numeric(raw.pricePerKwh) || raw.pricePerKwh < 0 || raw.pricePerKwh > 10) throw Error('Цената трябва да е от £0 до £10/kWh.');
  if (!optionalOdo(raw.odometerMiles)) throw Error('Невалиден километраж за зареждането.');
  textField(raw.station,120,'станция'); textField(raw.notes,500,'бележки');
  if (!validId(raw.id)) throw Error('Невалиден идентификатор на зареждане.');
  return raw;
}
function validateExpense(raw) {
  if (!raw || typeof raw !== 'object') throw Error('Невалиден разход.');
  if (!validId(raw.id)) throw Error('Невалиден идентификатор на разход.');
  if (!dateValid(raw.date)) throw Error('Въведи валидна дата за разхода.');
  if (!Object.hasOwn(COST_NAMES,raw.category)) throw Error('Избери категория на разхода.');
  if (!numeric(raw.amount) || raw.amount < 0 || raw.amount > 1000000) throw Error('Сумата трябва да е между £0 и £1,000,000.');
  if (!optionalOdo(raw.odometerMiles)) throw Error('Невалиден километраж за разхода.');
  if (raw.target !== undefined && !['ev','ice','both','other'].includes(raw.target)) throw Error('Невалиден автомобил към разхода.');
  textField(raw.title,120,'описание'); textField(raw.notes,500,'бележки');
  if (!raw.title.trim()) throw Error('Въведи описание на разхода.');
  return raw;
}
function validateGarage(raw) {
  if (!raw || typeof raw !== 'object') throw Error('Невалидни Garage данни.');
  textField(raw.make,60,'марка'); textField(raw.model,80,'модел');
  textField(raw.registration,20,'регистрация'); textField(raw.notes,500,'бележки');
  if (raw.year !== null && (!Number.isInteger(raw.year) || raw.year < 1950 || raw.year > 2100)) throw Error('Невалидна година на автомобила.');
  if (!optionalOdo(raw.odometerMiles)) throw Error('Невалиден километраж на автомобила.');
  if (!raw.due || typeof raw.due !== 'object') throw Error('Невалидни Garage срокове.');
  for (const key of Object.keys(DUE_NAMES)) {
    if (typeof raw.due[key] !== 'string' || (raw.due[key] && !dateValid(raw.due[key]))) throw Error(`Невалидна дата за ${DUE_NAMES[key]}.`);
  }
  // v0.1–v0.5 Garage records do not have `extras`. Accept them unchanged,
  // and add empty optional fields in memory/when next saved. No database migration.
  if (raw.extras !== undefined && (raw.extras === null || typeof raw.extras !== 'object' || Array.isArray(raw.extras))) {
    throw Error('Невалидни допълнителни Garage данни.');
  }
  const extras={...emptyGarageExtras(),...(raw.extras || {})};
  textField(extras.vin,25,'VIN');textField(extras.tyresNote,200,'гуми');
  if (!optionalOdo(extras.tyresOdometerMiles)) throw Error('Невалиден километраж при монтаж на гуми.');
  if (!optionalOdo(extras.nextServiceOdometerMiles)) throw Error('Невалиден километраж за следващ service.');
  for (const key of ['tyresInstalledDate','battery12vDate','cabinFilterDate','wipersDate']) {
    if (typeof extras[key] !== 'string' || (extras[key] && !dateValid(extras[key]))) throw Error('Невалидна дата в консумативите.');
  }
  return {...raw,extras};
}
function garageIsEmpty(profile) {
  const e={...emptyGarageExtras(),...(profile.extras || {})};
  return !profile.make && !profile.model && !profile.registration && profile.year === null && profile.odometerMiles === null && !profile.notes && !Object.values(profile.due).some(Boolean) &&
    !e.vin && !e.tyresInstalledDate && e.tyresOdometerMiles === null && !e.tyresNote && !e.battery12vDate && !e.cabinFilterDate && !e.wipersDate && e.nextServiceOdometerMiles === null;
}
function chargeFromForm() {
  const prior = chargeEditingId ? charges.find(x => x.id === chargeEditingId) : null;
  if ($('kwh').value.trim() === '' || $('price').value.trim() === '') throw Error('Попълни kWh и цена.');
  const odo = $('odometer').value.trim();
  return validateCharge({
    ...(prior || {}), // Keep legacy import provenance and unknown optional fields on edits.
    id:prior?.id || newId(),date:$('date').value,type:$('type').value,
    kwh:Number($('kwh').value),pricePerKwh:Number($('price').value),
    odometerMiles:odo === '' ? null : Number(odo),station:$('station').value.trim(),notes:$('notes').value.trim(),
    createdAt:prior?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString()
  });
}
function expenseFromForm() {
  const prior = expenseEditingId ? expenses.find(x => x.id === expenseEditingId) : null;
  if ($('expense-amount').value.trim() === '') throw Error('Попълни сума за разхода.');
  const odo = $('expense-odometer').value.trim();
  return validateExpense({
    id:prior?.id || newId(),date:$('expense-date').value,
    amount:roundPence(Number($('expense-amount').value)),category:$('expense-category').value,
    title:$('expense-title').value.trim(),target:$('expense-target').value,odometerMiles:odo === '' ? null : Number(odo),
    notes:$('expense-notes').value.trim(),createdAt:prior?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString()
  });
}
function garageFromForm() {
  const year = $('vehicle-year').value.trim();
  const odo = $('vehicle-odo').value.trim();
  const due = {};
  for (const key of Object.keys(DUE_NAMES)) due[key] = $(`due-${key}`).value;
  const tyresOdo=$('tyres-odo').value.trim();
  const nextServiceOdo=$('service-next-odo').value.trim();
  return validateGarage({
    make:$('vehicle-make').value.trim(),model:$('vehicle-model').value.trim(),
    year:year === '' ? null : Number(year),registration:$('vehicle-reg').value.trim().toUpperCase(),
    odometerMiles:odo === '' ? null : Number(odo),notes:$('vehicle-notes').value.trim(),due,
    extras:{
      vin:$('vehicle-vin').value.trim().toUpperCase(),
      tyresInstalledDate:$('tyres-installed-date').value,
      tyresOdometerMiles:tyresOdo === '' ? null : Number(tyresOdo),
      tyresNote:$('tyres-note').value.trim(),
      battery12vDate:$('battery-12v-date').value,
      cabinFilterDate:$('cabin-filter-date').value,
      wipersDate:$('wipers-date').value,
      nextServiceOdometerMiles:nextServiceOdo === '' ? null : Number(nextServiceOdo)
    }
  });
}
function resetChargeForm() {
  chargeEditingId = null;
  $('charge-form').reset(); $('date').value = today(); $('type').value = 'public';
  defaultPrice();
  $('charge-title').textContent='Нов запис';
  $('form-subtitle').textContent='Попълни информацията от зарядната станция.';
  $('save-charge').textContent='Запази зареждането';
  $('cancel-edit').textContent='Изчисти формата';
  renderChargeHelpers();
}
function defaultPrice() {
  const type = $('type').value;
  const last = charges.find(r => r.type === type);
  $('price').value=String(last ? last.pricePerKwh : PRICE_HINTS[type]);
  updatePreview();
  renderStationTariffSuggestion();
}

/* v1.2 — derived suggestions from saved history; no new IndexedDB keys.
 * A suggested tariff is NEVER applied while typing: only a button click uses it.
 */
function renderStationDatalist() {
  const list=$('station-suggestions');list.replaceChildren();
  const seen=new Set();
  for(const record of charges) {
    const name=(record.station || '').trim();
    const key=normalizedText(name);
    if(!key || seen.has(key))continue;
    seen.add(key);
    const option=document.createElement('option');option.value=name;list.append(option);
    if(seen.size>=100)break;
  }
}
function findSuggestedTariff(records,station,type) {
  const key=normalizedText(station);
  if(key) {
    const record=records.find(item=>normalizedText(item.station)===key);
    return record ? {record,fromStation:true} : null;
  }
  const record=records.find(item=>item.type===type);
  return record ? {record,fromStation:false} : null;
}
function renderStationTariffSuggestion() {
  const suggestion=findSuggestedTariff(charges,$('station').value,$('type').value);
  const hint=$('station-tariff-hint');
  const button=$('use-station-tariff');
  suggestedTariff=suggestion?.record || null;
  button.hidden=!suggestion;
  if(!suggestion) {
    hint.textContent=$('station').value.trim()
      ? 'Няма такава станция в историята. Можеш да въведеш актуалната цена ръчно.'
      : 'Няма записана цена за този тип зареждане. Въведи актуалната тарифа.';
    return;
  }
  const item=suggestion.record;
  hint.textContent=suggestion.fromStation
    ? `Последен запис за тази станция: ${fmtDate(item.date)} · ${TYPE_NAMES[item.type]} · £${item.pricePerKwh}/kWh.`
    : `Последна цена за ${TYPE_NAMES[item.type]}: £${item.pricePerKwh}/kWh (${fmtDate(item.date)}).`;
  button.textContent=suggestion.fromStation?'↺ Използвай този тип и цена':'↺ Използвай последната цена';
}
function chargeEntryWarnings({date,kwh,pricePerKwh,odometerMiles,id}) {
  const warnings=[];
  if(dateValid(date) && date>today())warnings.push('Датата е в бъдещето.');
  if(Number.isFinite(kwh) && kwh>100)warnings.push(`Количество ${kwh} kWh — необичайно голямо за едно зареждане.`);
  if(Number.isFinite(pricePerKwh) && pricePerKwh>1.25)warnings.push(`Цена £${pricePerKwh}/kWh — провери десетичната запетая и тарифата.`);
  if(Number.isFinite(kwh) && kwh>0 && Number.isFinite(pricePerKwh) && kwh*pricePerKwh>100)
    warnings.push(`Изчислената сума ${money(kwh*pricePerKwh)} надвишава £100.`);
  if(Number.isInteger(odometerMiles) && odometerMiles>=0 && dateValid(date)) {
    const previous=charges.find(item=>item.id!==id && Number.isInteger(item.odometerMiles) && item.odometerMiles>=0 && item.date<=date);
    if(previous && odometerMiles<previous.odometerMiles)
      warnings.push(`Километражът (${odometerMiles} mi) е под записаните ${previous.odometerMiles} mi от ${fmtDate(previous.date)}.`);
  }
  return warnings;
}
function entryWarningsFromForm() {
  const amount=$('kwh').value.trim();const price=$('price').value.trim();const odo=$('odometer').value.trim();
  return chargeEntryWarnings({
    date:$('date').value, kwh:amount===''?NaN:Number(amount),
    pricePerKwh:price===''?NaN:Number(price),odometerMiles:odo===''?null:Number(odo),id:chargeEditingId
  });
}
function updatePreview() {
  const rawKwh=$('kwh').value.trim(),rawPrice=$('price').value.trim();
  const kwh=rawKwh===''?NaN:Number(rawKwh),price=rawPrice===''?NaN:Number(rawPrice);
  const valid=Number.isFinite(kwh) && kwh>0 && kwh<=1000 && Number.isFinite(price) && price>=0 && price<=10;
  $('preview-total').textContent=valid?money(kwh*price):'—';
  const warnings=entryWarningsFromForm();
  const box=$('charge-entry-warnings');box.replaceChildren();box.hidden=!warnings.length;
  if(warnings.length){
    box.append(element('strong','','⚠ Провери преди запис:'));
    for(const message of warnings)box.append(element('p','',message));
  }
}
function renderChargeHelpers() {
  renderStationDatalist();renderStationTariffSuggestion();updatePreview();
}
function editCharge(id) {
  const item=charges.find(x=>x.id===id);
  if (!item) return notify('Зареждането не е намерено.',true);
  chargeEditingId=item.id;
  $('date').value=item.date; $('odometer').value=item.odometerMiles ?? '';
  $('type').value=item.type; $('kwh').value=item.kwh; $('price').value=item.pricePerKwh;
  $('station').value=item.station; $('notes').value=item.notes;
  $('charge-title').textContent='Редактиране на зареждане';
  $('form-subtitle').textContent='Промени полетата и запази.';
  $('save-charge').textContent='Запази промените';
  $('cancel-edit').textContent='Откажи редакцията';
  renderChargeHelpers(); navigate('charge');
}
function resetExpenseForm() {
  expenseEditingId=null;
  $('expense-form').reset();
  $('expense-date').value=today();
  $('expense-category').value='service';$('expense-target').value='ev';
  $('expense-form-title').textContent='Нов разход';
  $('save-expense').textContent='Запази разхода';
}
function openExpenseForm(id=null) {
  resetExpenseForm();
  if (id) {
    const item=expenses.find(x=>x.id===id);
    if (!item) return notify('Разходът не е намерен.',true);
    expenseEditingId=item.id;
    $('expense-date').value=item.date;
    $('expense-amount').value=item.amount;
    $('expense-category').value=item.category;$('expense-target').value=item.target || 'ev';
    $('expense-title').value=item.title;
    $('expense-odometer').value=item.odometerMiles ?? '';
    $('expense-notes').value=item.notes;
    $('expense-form-title').textContent='Редактиране на разход';
    $('save-expense').textContent='Запази промените';
  }
  $('expense-form').hidden=false;
  navigate('costs');
  $('expense-form').scrollIntoView({behavior:'smooth',block:'start'});
}
function loadGarageForm() {
  $('vehicle-make').value=garage.make;
  $('vehicle-model').value=garage.model;
  $('vehicle-year').value=garage.year ?? '';
  $('vehicle-reg').value=garage.registration;
  $('vehicle-odo').value=garage.odometerMiles ?? '';
  $('vehicle-notes').value=garage.notes;
  Object.keys(DUE_NAMES).forEach(key => {$(`due-${key}`).value=garage.due[key] || '';});
  const extras={...emptyGarageExtras(),...(garage.extras || {})};
  $('vehicle-vin').value=extras.vin;
  $('tyres-installed-date').value=extras.tyresInstalledDate;
  $('tyres-odo').value=extras.tyresOdometerMiles ?? '';
  $('tyres-note').value=extras.tyresNote;
  $('battery-12v-date').value=extras.battery12vDate;
  $('cabin-filter-date').value=extras.cabinFilterDate;
  $('wipers-date').value=extras.wipersDate;
  $('service-next-odo').value=extras.nextServiceOdometerMiles ?? '';
}
/* v0.8 — derived shortcuts. No new IndexedDB stores or settings. */
function recentStationPresets(items=charges,limit=4) {
  const keys=new Set(),result=[];
  // Sorted charges already have newest records first; keep explicit sort for testability.
  for (const item of [...items].sort(sortNewest)) {
    const key=`${item.type}|${normalizedText(item.station) || '(без име)'}`;
    if(keys.has(key)) continue;
    keys.add(key);result.push(item);
    if(result.length>=limit) break;
  }
  return result;
}
function reuseChargeStation(item) {
  if(!item) return notify('Не открих станцията.',true);
  resetChargeForm();
  $('type').value=item.type;
  $('station').value=item.station;
  $('price').value=String(item.pricePerKwh);
  // Do not copy old charging quantity, odometer or notes into a new session.
  $('kwh').value='';$('odometer').value='';$('notes').value='';
  renderChargeHelpers();navigate('charge');
  notify('Станцията и цената са попълнени. Въведи новите kWh и провери цената.');
}
function renderQuickStations() {
  const target=$('quick-stations');target.replaceChildren();
  const presets=recentStationPresets();
  if(!presets.length) {
    target.append(element('p','small-note','След първото записано зареждане тук ще се появят бързи бутони.'));
    return;
  }
  for(const item of presets) {
    const btn=element('button','station-shortcut');btn.type='button';
    btn.append(element('strong','',item.station || TYPE_NAMES[item.type]),
      element('span','',`${TYPE_NAMES[item.type]} · £${item.pricePerKwh.toFixed(3)}/kWh`));
    btn.addEventListener('click',()=>reuseChargeStation(item));
    target.append(btn);
  }
}
function chargeGroupStats(items,keyFn) {
  const grouped=new Map();
  for(const item of items) {
    const key=keyFn(item),prior=grouped.get(key);
    if(prior) {prior.count++;prior.kwh+=item.kwh;prior.cost+=chargeTotal(item);}
    else grouped.set(key,{key,label:'',count:1,kwh:item.kwh,cost:chargeTotal(item)});
  }
  return [...grouped.values()].map(row=>({...row,average:row.kwh>0?row.cost/row.kwh:null}));
}
function chargingBreakdownByType(items) {
  const rows=chargeGroupStats(items,item=>item.type);
  return rows.map(row=>({...row,label:TYPE_NAMES[row.key]||row.key}));
}
function chargingBreakdownByStation(items) {
  const names=new Map();
  const rows=chargeGroupStats(items,item=>{
    const key=normalizedText(item.station)||'__без_име__';
    if(!names.has(key)) names.set(key,item.station.trim() || 'Без посочена станция');
    return key;
  });
  return rows.map(row=>({...row,label:names.get(row.key)})).sort((a,b)=>b.kwh-a.kwh||b.cost-a.cost||a.label.localeCompare(b.label,'bg'));
}
function renderTariffRows(target,rows,limit=8) {
  target.replaceChildren();
  if(!rows.length) {target.append(element('p','small-note','Няма зареждания за избрания период.'));return;}
  for(const row of rows.slice(0,limit)) {
    const card=element('div','tariff-row');
    const top=element('div','tariff-heading');
    top.append(element('strong','',row.label),element('strong','tariff-price',`£${row.average.toFixed(3)}/kWh`));
    card.append(top,element('div','tariff-details',`${row.count} зареждания · ${energyFormat(row.kwh)} · ${money(row.cost)} общо`));
    target.append(card);
  }
  if(rows.length>limit)target.append(element('p','small-note',`Още ${rows.length-limit} места не са показани. Експортирай CSV за пълен преглед.`));
}
function actionButtons(card,type,id) {
  const row=element('div','record-actions');
  const edit=element('button','','Редактирай'); edit.type='button'; edit.dataset.action='edit'; edit.dataset.id=id;
  const del=element('button','danger','Изтрий'); del.type='button'; del.dataset.action='delete'; del.dataset.id=id;
  if(type==='charge') {
    const again=element('button','', '↺ Отново');again.type='button';again.dataset.action='reuse';again.dataset.id=id;
    row.append(again);
  }
  row.append(edit,del);card.append(row);
  return card;
}
function chargeCard(item,withActions=false) {
  const card=element('article','record');
  const top=element('div','record-top'),heading=element('div');
  heading.append(element('div','record-title',item.station || TYPE_NAMES[item.type]),element('div','record-date',fmtDate(item.date)));
  top.append(heading,element('div','record-value',money(chargeTotal(item))));card.append(top);
  const chips=element('div','record-meta');
  [`${item.kwh} kWh`,money(item.pricePerKwh)+'/kWh',TYPE_NAMES[item.type],...(item.odometerMiles===null?[]:[item.odometerMiles.toLocaleString('en-GB')+' mi'])].forEach(t=>chips.append(element('span','',t)));
  card.append(chips);
  if (item.notes) card.append(element('p','record-note',item.notes));
  if (withActions) actionButtons(card,'charge',item.id);
  return card;
}
function expenseCard(item,withActions=false) {
  const card=element('article','record');
  const top=element('div','record-top'),heading=element('div');
  heading.append(element('div','record-title',item.title),element('div','record-date',fmtDate(item.date)));
  top.append(heading,element('div','record-value',money(item.amount)));card.append(top);
  const chips=element('div','record-meta');
  [COST_NAMES[item.category],TARGET_NAMES[item.target||'ev'],...(item.odometerMiles===null?[]:[item.odometerMiles.toLocaleString('en-GB')+' mi'])].forEach(t=>chips.append(element('span','',t)));
  card.append(chips);
  if (item.notes) card.append(element('p','record-note',item.notes));
  if (withActions) actionButtons(card,'cost',item.id);
  return card;
}
function renderList(target,items,cardRenderer,withActions=false,empty='Няма записи за избрания период.') {
  target.replaceChildren();
  if (!items.length) {target.append(element('p','empty',empty));return;}
  const fragment=document.createDocumentFragment();
  items.forEach(item=>fragment.append(cardRenderer(item,withActions)));
  target.append(fragment);
}
// Move between calendar months without changing saved records or settings.
function shiftedMonth(key,delta) {
  const [year,month] = key.split('-').map(Number);
  const shifted=new Date(Date.UTC(year,month-1+delta,1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth()+1).padStart(2,'0')}`;
}
function moveOverviewMonth(delta) {
  const next=shiftedMonth(overviewMonth,delta);
  if(next>today().slice(0,7)) return;
  overviewMonth=next;
  renderHome();
}
function renderHome() {
  const current=overviewMonth;
  const monthCharges=charges.filter(x=>x.date.slice(0,7)===current);
  const monthExpenses=expenses.filter(x=>x.date.slice(0,7)===current);
  const charging=monthCharges.reduce((sum,x)=>sum+chargeTotal(x),0);
  const cost=monthExpenses.reduce((sum,x)=>sum+x.amount,0);
  const kwh=monthCharges.reduce((sum,x)=>sum+x.kwh,0);
  $('month-label').textContent=monthName(current);
  $('month-next').disabled=current>=today().slice(0,7);
  $('month-today').disabled=current===today().slice(0,7);
  $('month-cost').textContent=money(charging);
  $('month-kwh').textContent=kwh.toFixed(2)+' kWh';
  $('month-expense').textContent=money(cost);
  $('month-expense-count').textContent=`${monthExpenses.length} записа`;
  $('month-all').textContent=money(charging+cost);
  $('month-price').textContent=kwh>0?money(charging/kwh):'—';
  $('month-count').textContent=String(monthCharges.length);
  renderList($('recent-list'),charges.slice(0,3),chargeCard,false,'Все още няма зареждания.');
  renderList($('recent-costs'),expenses.slice(0,2),expenseCard,false,'Все още няма други разходи.');
  renderHomeReminders();
  renderQuickStations();
  $('garage-summary').textContent=garageIsEmpty(garage)?'Добави информация за автомобила и важните срокове.':
    [garage.make,garage.model,garage.registration,garage.odometerMiles===null?'':`${garage.odometerMiles.toLocaleString('en-GB')} mi`].filter(Boolean).join(' · ') || 'В Garage са запазени важни срокове.';
}
function renderMonthFilter(select,items) {
  const prior=select.value;
  const months=[...new Set(items.map(item=>item.date.slice(0,7)))].sort().reverse();
  select.replaceChildren(new Option('Всички месеци','all'));
  months.forEach(month=>select.add(new Option(monthName(month),month)));
  select.value=months.includes(prior)?prior:'all';
}
function renderHistory() {
  renderMonthFilter($('history-filter'),charges);
  const selected=$('history-filter').value;
  const selectedType=$('history-type-filter').value;
  const query=normalizedText($('history-search').value);
  const terms=query.split(' ').filter(Boolean);
  const items=charges.filter(x=>(selected==='all'||x.date.startsWith(selected)) &&
    (selectedType==='all'||x.type===selectedType) &&
    terms.every(term=>normalizedText([x.date,fmtDate(x.date),x.kwh,x.pricePerKwh,chargeTotal(x),x.type,TYPE_NAMES[x.type]||'',x.station,x.notes,x.odometerMiles??''].join(' ')).includes(term)));
  $('history-summary').textContent=`${items.length} от ${charges.length} зареждания`;
  $('history-clear').disabled=selected==='all' && selectedType==='all' && !$('history-search').value.trim();
  $('history-sum').textContent=money(items.reduce((sum,x)=>sum+chargeTotal(x),0));
  renderList($('history-list'),items,chargeCard,true);
}
function renderCosts() {
  renderMonthFilter($('costs-filter'),expenses);
  const selected=$('costs-filter').value;
  const category=$('cost-target-filter').value;
  const terms=normalizedText($('costs-search').value).split(' ').filter(Boolean);
  const items=expenses.filter(x=>(selected==='all'||x.date.startsWith(selected)) && (category==='all'||(x.target||'ev')===category) &&
    terms.every(term=>normalizedText([x.date,fmtDate(x.date),x.amount,x.category,COST_NAMES[x.category]||'',x.target,x.title,x.notes,x.odometerMiles??''].join(' ')).includes(term)));
  $('costs-summary').textContent=`${items.length} разхода`;
  $('costs-sum').textContent=money(items.reduce((sum,x)=>sum+x.amount,0));
  renderList($('costs-list'),items,expenseCard,true,'Няма други разходи за периода.');
}
function daysUntil(date) {
  const [sy,sm,sd]=today().split('-').map(Number);
  const [ey,em,ed]=date.split('-').map(Number);
  return Math.round((Date.UTC(ey,em-1,ed)-Date.UTC(sy,sm-1,sd))/86400000);
}
function garageDueItems() {
  const deadlines=Object.entries(DUE_NAMES)
    .filter(([key])=>garage.due[key])
    .map(([key,label])=>({kind:'date',key,label,date:garage.due[key],days:daysUntil(garage.due[key])}));
  const next=garage.extras?.nextServiceOdometerMiles;
  if (Number.isInteger(next) && next >= 0) {
    const current=garage.odometerMiles;
    const remaining=Number.isInteger(current) && current >= 0 ? next-current : null;
    deadlines.push({kind:'mileage',key:'service-odo',label:'Service по пробег',miles:next,remaining});
  }
  // Overdue and upcoming items first; unknown current odometer at the end.
  return deadlines.sort((a,b)=>{
    const aRank=a.kind==='date'?a.days:(a.remaining===null?Infinity:a.remaining<=0?-1: a.remaining<=500?7:90);
    const bRank=b.kind==='date'?b.days:(b.remaining===null?Infinity:b.remaining<=0?-1: b.remaining<=500?7:90);
    return aRank-bRank;
  });
}
function duePresentation(item) {
  if(item.kind==='mileage') {
    const label=`${item.label} · ${item.miles.toLocaleString('en-GB')} mi`;
    if(item.remaining===null) return {label,status:'Въведи текущ километраж в Garage',level:'normal'};
    if(item.remaining<0) return {label,status:`Надвишен с ${Math.abs(item.remaining).toLocaleString('en-GB')} mi`,level:'expired'};
    if(item.remaining===0) return {label,status:'Достигнат километраж',level:'expired'};
    if(item.remaining<=500) return {label,status:`Остават ${item.remaining.toLocaleString('en-GB')} mi`,level:'near'};
    return {label,status:`Остават ${item.remaining.toLocaleString('en-GB')} mi`,level:'normal'};
  }
  const label=`${item.label} · ${fmtDate(item.date)}`;
  if(item.days<0) return {label,status:`Просрочен с ${Math.abs(item.days)} дни`,level:'expired'};
  if(item.days===0) return {label,status:'Днес',level:'near'};
  if(item.days<=30) return {label,status:`След ${item.days} дни`,level:'near'};
  return {label,status:`След ${item.days} дни`,level:'normal'};
}
function renderHomeReminders() {
  const container=$('home-due-list');container.replaceChildren();
  const all=garageDueItems();
  if(!all.length){container.append(element('p','small-note','Няма въведени срокове. Добави MOT, insurance, tax или service в Garage.'));return;}
  all.slice(0,4).forEach(item=>{
    const display=duePresentation(item);
    const row=element('div',`due-item ${display.level}`);
    row.append(element('strong','',display.label),element('span','',display.status));
    container.append(row);
  });
  if(all.length>4) container.append(element('p','small-note',`Още ${all.length-4} срока се виждат в Garage.`));
}
function renderGarage() {
  const box=$('garage-alerts'); box.replaceChildren();
  const deadlines=garageDueItems();
  if (!deadlines.length) {
    box.append(element('p','small-note','Няма въведени срокове. Не ги проверяваме чрез DVLA или застраховател — въведи ги по документи.'));
  } else {
    deadlines.forEach(item => {
      const display=duePresentation(item);
      const alert=element('div',`due-item ${display.level}`);
      alert.append(element('strong','',display.label),element('span','',display.status));
      box.append(alert);
    });
  }
  // Read only: these entries are already present in Expenses, not duplicated.
  const history=$('garage-maintenance-list'); history.replaceChildren();
  const items=expenses.filter(x=>['service','tyres','repair'].includes(x.category) && ['ev','both'].includes(x.target || 'ev')).slice(0,5);
  if (!items.length) {
    history.append(element('p','small-note','Още няма EV разходи за сервиз, гуми или ремонт. Добави ги през „Разходи“.'));
  } else {
    items.forEach(item=>history.append(expenseCard(item,false)));
  }
}
/* Analytics never modifies charges, expenses or garage. All displays are derived from local records. */
function validateComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Невалидни настройки за сравнение.');
  for (const [key,min,max] of [['distanceMiles',1,100000],['efficiencyMiKwh',0.1,15],['iceMpgUk',5,200],['fuelPriceLitre',0,10],['manualPriceKwh',0,10]]) {
    if (!numeric(value[key]) || value[key] < min || value[key] > max) throw Error(`Невалидна настройка: ${key}.`);
  }
  if (!['history','manual'].includes(value.priceMode)) throw Error('Невалиден метод за цена на EV.');
  return value;
}
function comparisonFromForm() {
  const fieldNames = ['compare-distance','compare-efficiency','compare-mpg','compare-fuel-price','compare-manual-price'];
  if (fieldNames.some(id => $(id).value.trim() === '')) throw Error('Попълни всички полета за сравнение.');
  return validateComparison({
    distanceMiles:Number($('compare-distance').value),
    efficiencyMiKwh:Number($('compare-efficiency').value),
    iceMpgUk:Number($('compare-mpg').value),
    fuelPriceLitre:Number($('compare-fuel-price').value),
    priceMode:$('compare-price-mode').value,
    manualPriceKwh:Number($('compare-manual-price').value)
  });
}
function loadComparisonForm() {
  $('compare-distance').value=comparison.distanceMiles;
  $('compare-efficiency').value=comparison.efficiencyMiKwh;
  $('compare-mpg').value=comparison.iceMpgUk;
  $('compare-fuel-price').value=comparison.fuelPriceLitre;
  $('compare-price-mode').value=comparison.priceMode;
  $('compare-manual-price').value=comparison.manualPriceKwh;
  updateManualPriceVisibility();
}
function updateManualPriceVisibility() {
  $('manual-price-field').hidden=$('compare-price-mode').value!=='manual';
}
function periodScope() {
  const period=$('stats-period').value;
  const now=today().slice(0,7);
  const count=['3','6','12'].includes(period)?Number(period):null;
  let selectedCharges,selectedExpenses,months=[];
  if (period==='custom') {
    const {from,to}=customRange;
    const inPeriod=x=>x.date>=from && x.date<=to;
    selectedCharges=charges.filter(inPeriod);
    selectedExpenses=expenses.filter(inPeriod);
    const fromMonth=from.slice(0,7),toMonth=to.slice(0,7);
    const [fy,fm]=fromMonth.split('-').map(Number);
    const [ty,tm]=toMonth.split('-').map(Number);
    const span=(ty-fy)*12+(tm-fm)+1;
    if(span>0 && span<=36) {
      for(let i=0;i<span;i++)months.push(localDate(new Date(fy,fm-1+i,1)).slice(0,7));
    } else {
      months=[...new Set([...selectedCharges,...selectedExpenses].map(x=>x.date.slice(0,7)))].sort().slice(-36);
    }
  } else if (period==='all') {
    selectedCharges=charges;
    selectedExpenses=expenses;
    months=[...new Set([...selectedCharges,...selectedExpenses].map(x=>x.date.slice(0,7)))].sort().slice(-36);
  } else {
    const first=localDate(new Date(new Date().getFullYear(),new Date().getMonth()-count+1,1)).slice(0,7);
    const inPeriod=x=>x.date.slice(0,7)>=first && x.date.slice(0,7)<=now;
    selectedCharges=charges.filter(inPeriod);
    selectedExpenses=expenses.filter(inPeriod);
    for(let i=count-1;i>=0;i--)months.push(localDate(new Date(new Date().getFullYear(),new Date().getMonth()-i,1)).slice(0,7));
  }
  return {selectedCharges,selectedExpenses,months,period};
}
function monthValid(value) {
  return typeof value==='string' && /^\d{4}-\d{2}$/.test(value) && dateValid(`${value}-01`);
}
function compareMonthValues(month) {
  const foundCharges=charges.filter(x=>x.date.startsWith(month));
  const foundExpenses=expenses.filter(x=>x.date.startsWith(month));
  const charging=foundCharges.reduce((total,x)=>total+chargeTotal(x),0);
  const other=foundExpenses.reduce((total,x)=>total+x.amount,0);
  const kwh=foundCharges.reduce((total,x)=>total+x.kwh,0);
  return {month,charging,other,total:charging+other,kwh,chargeCount:foundCharges.length,expenseCount:foundExpenses.length};
}
function renderMonthComparison() {
  const box=$('stats-month-comparison');box.replaceChildren();
  const left=$('stats-month-a').value,right=$('stats-month-b').value;
  if(!monthValid(left) || !monthValid(right)) {
    box.append(element('p','small-note','Избери два валидни месеца за сравнение.'));
    return;
  }
  const a=compareMonthValues(left),b=compareMonthValues(right);
  const wrap=element('div','month-compare-grid');
  for (const [item,tag] of [[a,'A'],[b,'B']]) {
    const card=element('div','month-compare-card');
    card.append(element('span','month-compare-label',`Месец ${tag} · ${monthName(item.month)}`));
    const metrics=[
      ['Общо разходи',money(item.total)],
      ['Зареждане',money(item.charging)],
      ['Други разходи',money(item.other)],
      ['Заредено',energyFormat(item.kwh)],
      ['Зареждания',String(item.chargeCount)],
      ['Средно £/kWh',item.kwh>0?'£'+(item.charging/item.kwh).toFixed(3):'—']
    ];
    for(const [label,value] of metrics) {
      const line=element('div','month-compare-line');
      line.append(element('span','',label),element('strong','',value));card.append(line);
    }
    wrap.append(card);
  }
  box.append(wrap);
  const diff=roundPence(b.total-a.total);
  const display=diff===0?'£0.00':(diff>0?'+':'−')+money(Math.abs(diff));
  const percentage=a.total>0?`${Math.abs(diff/a.total*100).toFixed(1)}%`:'—';
  const info=element('div','month-compare-difference');
  info.append(element('span','small-note','Разлика в общите разходи: B спрямо A'));
  info.append(element('strong','',`${display}${percentage!=='—'?' ('+percentage+')':''}`));
  let explanation='Общите разходи са еднакви.';
  if(diff>0)explanation='През месец B общите записани разходи са по-високи.';
  if(diff<0)explanation='През месец B общите записани разходи са по-ниски.';
  if(a.total===0)explanation+=' Няма ненулева база за процентно сравнение с месец A.';
  info.append(element('p','small-note',explanation));
  box.append(info);
}
function renderCustomRangeControls() {
  const active=$('stats-period').value==='custom';
  $('stats-custom-range').hidden=!active;
  if(active) {
    $('stats-range-status').textContent=`Приложено: ${fmtDate(customRange.from)} – ${fmtDate(customRange.to)}.`;
  }
}
function applyCustomRange() {
  const from=$('stats-date-from').value,to=$('stats-date-to').value;
  if(!dateValid(from) || !dateValid(to)) {
    $('stats-range-status').textContent='⚠ Избери две валидни дати.';
    return;
  }
  if(from>to) {
    $('stats-range-status').textContent='⚠ Началната дата трябва да бъде преди или равна на крайната.';
    return;
  }
  customRange={from,to};renderStats();
}

function energyFormat(kwh) {
  return Number(kwh).toLocaleString('en-GB',{minimumFractionDigits:0,maximumFractionDigits:2})+' kWh';
}
function barChart(container,rows,maxValue,mode) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(element('p','small-note','Няма данни за избрания период.'));
    return;
  }
  for (const row of rows) {
    const entry=element('div','chart-row');
    const label=element('span','chart-label',row.label);
    const content=element('div','chart-content');
    const track=element('div','chart-track');
    if(mode==='cost') {
      for(const [value,cls] of [[row.charging,'segment-charging'],[row.other,'segment-expense']]) {
        const segment=element('div','chart-segment '+cls);
        segment.style.width = maxValue>0 ? (100*value/maxValue)+'%' : '0%';
        track.append(segment);
      }
      track.setAttribute('aria-label',`${row.label}: зареждане ${money(row.charging)}, други ${money(row.other)}`);
      content.append(track,element('div','chart-value',`${money(row.charging+row.other)} · зареждане ${money(row.charging)} / други ${money(row.other)}`));
    } else {
      const segment=element('div','chart-segment segment-energy');
      segment.style.width=maxValue>0 ? (100*row.kwh/maxValue)+'%' : '0%';
      track.append(segment);
      track.setAttribute('aria-label',`${row.label}: ${energyFormat(row.kwh)}`);
      content.append(track,element('div','chart-value',energyFormat(row.kwh)));
    }
    entry.append(label,content);container.append(entry);
  }
}
function renderTypeBreakdown(selectedCharges,totalKwh) {
  const box=$('stats-type-bars');box.replaceChildren();
  if (!selectedCharges.length) {box.append(element('p','small-note','Няма зареждания за този период.'));return;}
  for (const [type,label] of Object.entries(TYPE_NAMES)) {
    const total=selectedCharges.filter(x=>x.type===type).reduce((sum,x)=>sum+x.kwh,0);
    if(total===0)continue;
    const pct=totalKwh>0?total/totalKwh*100:0;
    const entry=element('div','chart-row');
    const line=element('div','chart-content');
    const track=element('div','chart-track');
    const segment=element('div','chart-segment segment-charging');segment.style.width=pct+'%';track.append(segment);
    line.append(track,element('div','chart-value',`${energyFormat(total)} · ${pct.toFixed(1)}%`));
    entry.append(element('span','chart-label',label),line);box.append(entry);
  }
}
function renderComparison(config=comparison,scope=periodScope()) {
  const box=$('comparison-result');box.replaceChildren();
  const totalKwh=scope.selectedCharges.reduce((sum,x)=>sum+x.kwh,0);
  const recorded=scope.selectedCharges.reduce((sum,x)=>sum+chargeTotal(x),0);
  if (config.priceMode==='history' && totalKwh<=0) {
    box.append(element('h2','','Няма база за EV цена'),element('p','','Няма записани зареждания през избрания период. Избери „Въведена от мен цена“ или друг период, за да направиш сравнение.'));
    return;
  }
  const evPrice=config.priceMode==='history'?recorded/totalKwh:config.manualPriceKwh;
  const evKwh=config.distanceMiles/config.efficiencyMiKwh;
  const evCost=evKwh*evPrice;
  const iceLitres=config.distanceMiles/config.iceMpgUk*4.54609;
  const iceCost=iceLitres*config.fuelPriceLitre;
  const difference=iceCost-evCost;
  box.append(element('h2','','Резултат за '+config.distanceMiles.toLocaleString('en-GB')+' мили'));
  const figures=element('div','compare-figures');
  for (const [label,cost] of [['Електромобил',evCost],['Бензин / дизел',iceCost]]) {
    const card=element('div','compare-figure');card.append(element('span','',label),element('strong','',money(cost)));figures.append(card);
  }
  box.append(figures);
  const highlight=element('div','compare-highlight');
  highlight.append(element('span','small-note','Разлика само за енергия / гориво'));
  const delta=Math.abs(difference)<0.005?'Приблизително еднакъв разход':difference>0?`EV е по-евтин с ${money(difference)}`:`ICE е по-евтин с ${money(-difference)}`;
  highlight.append(element('strong','',delta));
  highlight.append(element('p','',`${energyFormat(evKwh)} × £${evPrice.toFixed(3)}/kWh · ${iceLitres.toFixed(2)} литра × ${money(config.fuelPriceLitre)}/л`));
  highlight.append(element('p','',config.priceMode==='history'?'EV цената е претеглената средна от реално въведените зареждания за избрания период.':'EV цената е зададена ръчно в настройките.'));
  box.append(highlight);
}
/* v0.9 — purely derived mileage/charging-cost indicator. Nothing is stored.
 * We deliberately do not call this measured mi/kWh: charging != battery consumption.
 * Start-day charging is excluded (ambiguous ordering on a date-only record).
 * Last-day charging is included. This is only a rough spend/distance proxy.
 */
function mileageEstimate(items) {
  const readings = items.filter(x => Number.isInteger(x.odometerMiles) && x.odometerMiles >= 0 && x.odometerMiles <= 9999999)
    .sort((a,b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  if (readings.length < 2) return {status:'few-readings',readings:readings.length};
  const first=readings[0],last=readings[readings.length-1];
  if (first.date===last.date) return {status:'same-day',readings:readings.length};
  for(let i=1;i<readings.length;i++) {
    // Do not display a monetary ratio if recorded mileage decreases, even on the same day.
    if(readings[i].odometerMiles < readings[i-1].odometerMiles) {
      return {status:'inconsistent',readings:readings.length};
    }
  }
  const distance=last.odometerMiles-first.odometerMiles;
  if (distance<=0) return {status:'no-distance',readings:readings.length};
  const interval=items.filter(x => x.date>first.date && x.date<=last.date);
  if (!interval.length) return {status:'no-charges',readings:readings.length,first,last,distance};
  const paid=interval.reduce((sum,x)=>sum+chargeTotal(x),0);
  const missing=interval.filter(x=>x.odometerMiles==null).length;
  return {status:'ok',readings:readings.length,first,last,distance,paid,chargeCount:interval.length,missing,
    pencePerMile:paid/distance*100};
}
function renderMileageEstimate(scope=periodScope()) {
  const target=$('mileage-summary');target.replaceChildren();
  const result=mileageEstimate(scope.selectedCharges);
  const hints={
    'few-readings':'Нужни са поне две зареждания с попълнен километраж на различни дати. Записвай показанията в мили при следващите зареждания.',
    'same-day':'Наличните показания са само от един ден. Нужни са стойности от различни дати.',
    'inconsistent':'Открит е намаляващ километраж. Провери и коригирай показанията в „История“, преди да използваш тази справка.',
    'no-distance':'Между първото и последното показание няма отчетен положителен пробег.',
    'no-charges':'Има пробег, но няма записани зареждания между двете крайни дати. Не може да се изчисли цена на миля.'
  };
  if(result.status!=='ok') {
    target.append(element('p','mileage-message',hints[result.status]));
    target.append(element('p','small-note',`Попълнени показания за периода: ${result.readings}.`));
    return;
  }
  const grid=element('div','mileage-grid');
  for(const [label,value] of [
    ['Пробег',`${result.distance.toLocaleString('en-GB')} mi`],
    ['Зареждания в интервала',String(result.chargeCount)],
    ['Платено за зареждане',money(result.paid)],
    ['Ориентировъчно',`${result.pencePerMile.toFixed(2)} p/mi`]
  ]) {
    const card=element('div','mileage-figure');
    card.append(element('span','',label),element('strong','',value));grid.append(card);
  }
  target.append(grid);
  target.append(element('p','mileage-dates',
    `${fmtDate(result.first.date)}: ${result.first.odometerMiles.toLocaleString('en-GB')} mi → ${fmtDate(result.last.date)}: ${result.last.odometerMiles.toLocaleString('en-GB')} mi`));
  if (result.missing) target.append(element('p','mileage-warning',
    `${result.missing} от ${result.chargeCount} зареждания в интервала са без километраж. Те са включени в сумата, но не служат за крайни показания.`));
  target.append(element('p','small-note','Началният ден е изключен от сумата; последният е включен. Разликата в нивото на батерията не се отчита.'));
}
/* v1.6 — record-based EV/ICE costs, not a like-for-like cost comparison.
 * Only charges belong to EV automatically; car-assigned expenses are counted
 * exactly once. 'both' and 'other' must not be silently assigned to either.
 * Historical expenses without a target use the app's legacy default 'ev'. */
function actualCostsForScope(scope=periodScope()) {
  const result={
    evCharging:0,evChargingCount:scope.selectedCharges.length,
    evOther:0,evOtherCount:0,iceFuel:0,iceFuelCount:0,
    iceOther:0,iceOtherCount:0,shared:0,sharedCount:0,
    unassigned:0,unassignedCount:0
  };
  result.evCharging=scope.selectedCharges.reduce((sum,x)=>sum+chargeTotal(x),0);
  for(const expense of scope.selectedExpenses) {
    const target=expense.target || 'ev'; // historical compatibility
    const amount=expense.amount;
    if(target==='ev') { result.evOther+=amount; result.evOtherCount++; }
    else if(target==='ice') {
      if(expense.category==='fuel') {result.iceFuel+=amount;result.iceFuelCount++;}
      else {result.iceOther+=amount;result.iceOtherCount++;}
    } else if(target==='both') {result.shared+=amount;result.sharedCount++;}
    else {result.unassigned+=amount;result.unassignedCount++;}
  }
  result.evTotal=result.evCharging+result.evOther;
  result.iceTotal=result.iceFuel+result.iceOther;
  result.allTotal=result.evTotal+result.iceTotal+result.shared+result.unassigned;
  return result;
}
function actualCostsCsvRows(scope=periodScope()) {
  const x=actualCostsForScope(scope);
  return [
    ['vehicle','category','record_count','amount_gbp'],
    ['EV','charging',x.evChargingCount,roundPence(x.evCharging).toFixed(2)],
    ['EV','other_expenses',x.evOtherCount,roundPence(x.evOther).toFixed(2)],
    ['EV','total',x.evChargingCount+x.evOtherCount,roundPence(x.evTotal).toFixed(2)],
    ['ICE','fuel',x.iceFuelCount,roundPence(x.iceFuel).toFixed(2)],
    ['ICE','other_expenses',x.iceOtherCount,roundPence(x.iceOther).toFixed(2)],
    ['ICE','total',x.iceFuelCount+x.iceOtherCount,roundPence(x.iceTotal).toFixed(2)],
    ['Shared','not_allocated',x.sharedCount,roundPence(x.shared).toFixed(2)],
    ['Unassigned','not_allocated',x.unassignedCount,roundPence(x.unassigned).toFixed(2)],
    ['All','grand_total',scope.selectedCharges.length+scope.selectedExpenses.length,roundPence(x.allTotal).toFixed(2)]
  ];
}
function renderActualCosts(scope=periodScope()) {
  const x=actualCostsForScope(scope),box=$('actual-costs-summary');
  box.replaceChildren();
  const grid=element('div','actual-vehicle-grid');
  for(const vehicle of [
    {title:'Електромобил (EV)',total:x.evTotal,rows:[['Зареждане',x.evCharging,x.evChargingCount],['Други EV разходи',x.evOther,x.evOtherCount]]},
    {title:'Бензин / дизел (ICE)',total:x.iceTotal,rows:[['Гориво',x.iceFuel,x.iceFuelCount],['Други ICE разходи',x.iceOther,x.iceOtherCount]]}
  ]) {
    const card=element('div','actual-vehicle-card');
    card.append(element('span','actual-vehicle-title',vehicle.title),element('strong','actual-vehicle-total',money(vehicle.total)));
    for(const [label,value,count] of vehicle.rows) {
      const row=element('div','actual-cost-line');
      row.append(element('span','',`${label} (${count})`),element('strong','',money(value)));
      card.append(row);
    }
    grid.append(card);
  }
  box.append(grid);
  const others=element('div','actual-other-costs');
  for(const [label,value,count] of [
    ['Общи — без разпределение',x.shared,x.sharedCount],
    ['Неуточнени — без разпределение',x.unassigned,x.unassignedCount],
    ['Всички записани разходи',x.allTotal,scope.selectedCharges.length+scope.selectedExpenses.length]
  ]) {
    const row=element('div','actual-cost-line');
    row.append(element('span','',`${label} (${count})`),element('strong','',money(value)));
    others.append(row);
  }
  box.append(others);
  if(!x.iceFuelCount)box.append(element('p','actual-cost-warning','ℹ Няма отделни ICE разходи с категория „Гориво“ в избрания период. Провери дали горивото е въведено и правилно категоризирано.'));
  if(x.sharedCount || x.unassignedCount)box.append(element('p','small-note','Общите и неуточнените разходи не се включват в нито една автомобилна сума.'));
}
function exportActualCostsCsv() {
  const scope=periodScope();
  downloadCsv(actualCostsCsvRows(scope),`EV-Log-2-actual-EV-ICE-${periodExportTag(scope)}-${today()}.csv`);
  notify('Справката EV/ICE е експортирана като CSV. JSON backup остава отделен.');
}
function renderStats() {
  renderCustomRangeControls();
  renderMonthComparison();
  const scope=periodScope();
  renderPeriodExportScope(scope);
  $('stats-scope-caption').textContent=scope.period==='custom'
    ?`Период: ${fmtDate(customRange.from)} – ${fmtDate(customRange.to)} · включително.`
    :scope.period==='all'?'Период: всички въведени записи.':`Период: последните ${scope.period} календарни месеца, включително текущия.`;
  const cs=scope.selectedCharges,ex=scope.selectedExpenses;
  const charging=cs.reduce((sum,x)=>sum+chargeTotal(x),0);
  const extra=ex.reduce((sum,x)=>sum+x.amount,0);
  const kwh=cs.reduce((sum,x)=>sum+x.kwh,0);
  $('stats-charging').textContent=money(charging);
  $('stats-other').textContent=money(extra);
  $('stats-total').textContent=money(charging+extra);
  $('stats-charge-count').textContent=`${cs.length} зареждания`;
  $('stats-other-count').textContent=`${ex.length} разхода`;
  $('stats-kwh').textContent=energyFormat(kwh);
  $('stats-average-session').textContent=cs.length?`Средно: ${energyFormat(kwh/cs.length)}`:'Средно: —';
  $('stats-average-price').textContent=kwh>0?'£'+(charging/kwh).toFixed(3):'—';
  $('stats-session-cost').textContent=cs.length?money(charging/cs.length):'—';
  const rows=scope.months.map(m=>({
    label:new Intl.DateTimeFormat('bg-BG',{month:'short',year:'2-digit'}).format(new Date(m+'-01T12:00:00')),
    charging:cs.filter(x=>x.date.startsWith(m)).reduce((sum,x)=>sum+chargeTotal(x),0),
    other:ex.filter(x=>x.date.startsWith(m)).reduce((sum,x)=>sum+x.amount,0),
    kwh:cs.filter(x=>x.date.startsWith(m)).reduce((sum,x)=>sum+x.kwh,0)
  }));
  barChart($('stats-cost-bars'),rows,Math.max(0,...rows.map(x=>x.charging+x.other)),'cost');
  barChart($('stats-energy-bars'),rows,Math.max(0,...rows.map(x=>x.kwh)),'energy');
  renderTypeBreakdown(cs,kwh);
  renderTariffRows($('stats-price-by-type'),chargingBreakdownByType(cs));
  renderTariffRows($('stats-price-by-station'),chargingBreakdownByStation(cs));
  renderMileageEstimate(scope);
  renderActualCosts(scope);
  renderComparison(comparison,scope);
}

function renderAll() {
  renderHome();renderHistory();renderCosts();renderGarage();renderStats();
  $('backup-count').textContent=`В момента: ${charges.length} зареждания, ${expenses.length} други разхода${garageIsEmpty(garage)?', Garage е празен.':', Garage е попълнен.'}`;
  renderAuditOverview();
}
function chargeSignature(x) {return [x.date,x.odometerMiles??'',x.type,x.kwh,x.pricePerKwh,x.station.trim().toLowerCase(),x.notes.trim().toLowerCase()].join('\u001f');}
function expenseSignature(x) {return [x.date,x.amount,x.category,x.target||'ev',x.title.trim().toLowerCase(),x.odometerMiles??'',x.notes.trim().toLowerCase()].join('\u001f');}
/* v1.0: protect against accidentally entering an identical manual record twice.
   Legitimate repeat sessions are still possible after explicit confirmation. */
function confirmExactDuplicate(record,kind) {
  const isCharge=kind==='charge';
  const same=isCharge?chargeSignature:expenseSignature;
  const rows=isCharge?charges:expenses;
  const duplicate=rows.find(x=>x.id!==record.id && same(x)===same(record));
  if (!duplicate) return true;
  return confirm(`⚠ Вече има напълно съвпадащ ${isCharge?'запис за зареждане':'запис за разход'} от ${fmtDate(record.date)}.\n\nАко това е отделно реално събитие, натисни OK. В противен случай натисни Отказ.`);
}

function validateBackup(data) {
  if (!data || data.format!==BACKUP_FORMAT || ![1,2].includes(data.version) || !Array.isArray(data.charges)) throw Error('Невалиден архив от EV Log 2.0 (очаква се JSON формат ev-log-2).');
  if (data.charges.length>100000) throw Error('Прекалено много зареждания в архива.');
  const chargeIds=new Set();
  data.charges.forEach(x=>{validateCharge(x);if(chargeIds.has(x.id)) throw Error('Повтарящи се ID на зареждания в архива.');chargeIds.add(x.id);});
  let importedCosts=[],importedGarage=null,importedComparison=null;
  if (data.version===2) {
    if (!Array.isArray(data.costs)) throw Error('Липсват разходите в архива v0.2.');
    if (data.costs.length>100000) throw Error('Прекалено много разходи в архива.');
    const costIds=new Set();
    data.costs.forEach(x=>{validateExpense(x);if(costIds.has(x.id)) throw Error('Повтарящи се ID на разходи в архива.');costIds.add(x.id);});
    importedCosts=data.costs;
    if (data.garage !== null && data.garage !== undefined) importedGarage=validateGarage(data.garage);
    if (data.comparison !== null && data.comparison !== undefined) importedComparison=validateComparison(data.comparison);
  }
  return {charges:data.charges,costs:importedCosts,garage:importedGarage,comparison:importedComparison};
}
/* v1.3: SHA-256 detects accidental changes to exported archives.
   The existing ev-log-2 version:2 format is preserved; older readers ignore
   the optional integrity field. This is NOT a digital signature or password. */
const INTEGRITY_FIELDS = ['format','version','exportedAt','charges','costs','garage','comparison'];
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const out=JSON.stringify(value);
    if (out===undefined) throw Error('Невалидна стойност за архивиране.');
    return out;
  }
  if (Array.isArray(value)) return '['+value.map(v=>canonicalJson(v===undefined?null:v)).join(',')+']';
  return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
}
async function archiveHash(payload) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder==='undefined') throw Error('Браузърът не поддържа SHA-256. Отвори приложението през HTTPS в Chrome.');
  const covered=Object.fromEntries(INTEGRITY_FIELDS.map(key=>[key,payload[key]]));
  const encoded=new TextEncoder().encode(canonicalJson(covered));
  const result=await crypto.subtle.digest('SHA-256',encoded);
  return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');
}
async function verifyArchiveHash(payload) {
  if (!Object.hasOwn(payload,'integrity')) return {verified:false,description:'Стар архив без SHA-256 — формата и записите са проверени, но целостта не може да се потвърди криптографски.'};
  const tag=payload.integrity;
  if (!tag || tag.algorithm!=='SHA-256' || typeof tag.hex!=='string' || !/^[0-9a-f]{64}$/.test(tag.hex)) {
    throw Error('Невалидна контролна сума SHA-256 в архива. Не са внесени данни.');
  }
  const calculated=await archiveHash(payload);
  if (calculated!==tag.hex) throw Error('⚠ SHA-256 проверката не съвпада. Архивът може да е повреден или променен. Нищо не е добавено.');
  return {verified:true,description:'✅ SHA-256 съвпада: данните са съгласувани с контролната сума в архива (не доказва произхода му).'};
}
function backupFilename() {
  const d=new Date();
  const time=[d.getHours(),d.getMinutes(),d.getSeconds()].map(x=>String(x).padStart(2,'0')).join('');
  return `EV-Log-2-full-backup-${localDate(d)}-${time}.json`;
}
async function makeBackupFile() {
  await refresh();
  const payload={format:BACKUP_FORMAT,version:2,exportedAt:new Date().toISOString(),charges:charges.map(x=>({...x})),costs:expenses.map(x=>({...x})),garage:JSON.parse(JSON.stringify(garage)),comparison:{...comparison}};
  payload.integrity={algorithm:'SHA-256',hex:await archiveHash(payload)};
  const name=backupFilename();
  const json=JSON.stringify(payload,null,2);
  return new File([json],name,{type:'application/json'});
}
async function downloadBackup() {
  const file=await makeBackupFile();
  const url=URL.createObjectURL(file);
  const a=document.createElement('a');a.href=url;a.download=file.name;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  $('backup-export-status').textContent='Архивът '+file.name+' е подготвен с SHA-256. Провери дали е записан в Downloads. Избери го от „Възстановяване“, за да провериш файла.';
  notify('Архивът е подготвен. Провери Downloads и избери файла за проверка.');
}
function supportsFileSharing() {
  if (typeof File==='undefined' || typeof navigator.share!=='function' || typeof navigator.canShare!=='function') return false;
  try {return navigator.canShare({files:[new File(['test'],'evlog-test.json',{type:'application/json'})]});}
  catch (_) {return false;}
}
async function shareBackup() {
  if (!supportsFileSharing()) throw Error('Android споделяне на файл не е достъпно тук. Използвай „Изтегли“ и сподели файла от Downloads.');
  const file=await makeBackupFile();
  // Android share sheet is user-controlled. No upload is made by the app itself.
  try {
    await navigator.share({files:[file],title:'EV Log 2.0 — архив'});
    $('backup-export-status').textContent='Изпратен е файл за споделяне. Провери, че си го запазил на избраното място. Не го публикувай в GitHub.';
  } catch (error) {
    if (error.name==='AbortError') {notify('Споделянето е отменено. Няма промяна в данните.');return;}
    throw error;
  }
}
/* v1.0: explicit, read-only preview before full JSON backup restore.
   Format, signatures, original records and database version are unchanged. */
let pendingBackup = null;
let backupPlanShown = null;
function planFullBackup(incoming) {
  const existingChargeIds = new Map(charges.map(x=>[x.id,x]));
  const existingCostIds = new Map(expenses.map(x=>[x.id,x]));
  const chargePrints = new Set(charges.map(chargeSignature));
  const costPrints = new Set(expenses.map(expenseSignature));
  const newCharges=[],newCosts=[];
  const counts={chargeDuplicate:0,chargeConflict:0,costDuplicate:0,costConflict:0};
  for (const item of incoming.charges) {
    const print=chargeSignature(item);
    const sameId=existingChargeIds.get(item.id);
    if (sameId) {
      if (chargeSignature(sameId)===print) counts.chargeDuplicate++;
      else counts.chargeConflict++;
    } else if (chargePrints.has(print)) counts.chargeDuplicate++;
    else {
      newCharges.push(item);existingChargeIds.set(item.id,item);chargePrints.add(print);
    }
  }
  for (const item of incoming.costs) {
    const print=expenseSignature(item);
    const sameId=existingCostIds.get(item.id);
    if (sameId) {
      if (expenseSignature(sameId)===print) counts.costDuplicate++;
      else counts.costConflict++;
    } else if (costPrints.has(print)) counts.costDuplicate++;
    else {
      newCosts.push(item);existingCostIds.set(item.id,item);costPrints.add(print);
    }
  }
  const addGarage=!!incoming.garage && garageIsEmpty(garage) && !garageIsEmpty(incoming.garage);
  const addComparison=!!incoming.comparison && !comparisonStored;
  return {newCharges,newCosts,counts,addGarage,addComparison};
}
function planIdentity(plan) {
  return JSON.stringify({
    charges:plan.newCharges.map(x=>x.id),costs:plan.newCosts.map(x=>x.id),
    ...plan.counts,garage:plan.addGarage,comparison:plan.addComparison,
    snapshot:dbSnapshot()
  });
}
function clearBackupPreview() {
  pendingBackup=null;backupPlanShown=null;
  $('backup-ack').checked=false;
  $('backup-commit').disabled=true;
  $('backup-preview').hidden=true;
  $('backup-preview-details').replaceChildren();
  $('selected-file').textContent='Няма избран файл';
}
function renderBackupPreview(plan,filename,exportedAt='',integrityInfo=null,incoming=null) {
  const target=$('backup-preview-details');target.replaceChildren();
  const line=(s,warn=false)=>target.append(element('div',warn?'backup-preview-line warning':'backup-preview-line',s));
  line(`Файл: ${filename}`);
  if (integrityInfo) line(integrityInfo.description,!integrityInfo.verified);
  if (incoming) line(`В архива: ${incoming.charges.length} зареждания, ${incoming.costs.length} разхода · Garage: ${incoming.garage?'включен':'липсва'} · EV/ICE: ${incoming.comparison?'включени':'липсват'}`);
  if (exportedAt) {
    const stamp=new Date(exportedAt);
    if (!Number.isNaN(stamp.getTime())) line(`Дата на архива: ${stamp.toLocaleString('bg-BG')}`);
  }
  line(`Нови зареждания: ${plan.newCharges.length} · Повторени: ${plan.counts.chargeDuplicate}`);
  line(`Нови разходи: ${plan.newCosts.length} · Повторени: ${plan.counts.costDuplicate}`);
  const conflicts=plan.counts.chargeConflict+plan.counts.costConflict;
  if (conflicts) line(`⚠ ${conflicts} конфликта: еднакъв ID, но различни данни. Няма да бъдат презаписани.`,true);
  line(`Garage: ${plan.addGarage?'ще се добави':'без промяна'} · EV/ICE настройки: ${plan.addComparison?'ще се добавят':'без промяна'}`);
  if (!(plan.newCharges.length || plan.newCosts.length || plan.addGarage || plan.addComparison)) {
    line('Няма данни за добавяне. Можеш да затвориш този преглед.');
  }
  $('backup-preview').hidden=false;
  if (pendingBackup) pendingBackup.canRestore=!!(plan.newCharges.length || plan.newCosts.length || plan.addGarage || plan.addComparison);
  $('backup-commit').disabled=!$('backup-ack').checked || !pendingBackup?.canRestore;
}
async function previewBackupFile(file) {
  clearBackupPreview();
  if (file.size>30*1024*1024) throw Error('Архивът е твърде голям (макс. 30 MB).');
  let obj;
  try {obj=JSON.parse(await file.text());} catch (_) {throw Error('Файлът не е валиден JSON.');}
  const incoming=validateBackup(obj);
  const integrityInfo=await verifyArchiveHash(obj);
  await refresh();
  const plan=planFullBackup(incoming);
  pendingBackup={incoming,filename:file.name,exportedAt:obj.exportedAt || '',integrityInfo};
  backupPlanShown=planIdentity(plan);
  renderBackupPreview(plan,file.name,pendingBackup.exportedAt,integrityInfo,incoming);
  notify('Архивът е проверен. Нищо не е добавено или изтрито.');
}
async function commitFullBackup() {
  if (!pendingBackup || !$('backup-ack').checked) throw Error('Първо провери архива и потвърди, че имаш резервно копие.');
  await refresh();
  const plan=planFullBackup(pendingBackup.incoming);
  if (planIdentity(plan)!==backupPlanShown) {
    backupPlanShown=planIdentity(plan);
    $('backup-ack').checked=false;
    renderBackupPreview(plan,pendingBackup.filename,pendingBackup.exportedAt,pendingBackup.integrityInfo,pendingBackup.incoming);
    throw Error('Данните са се променили след прегледа. Провери новите бройки и потвърди отново.');
  }
  if (!(plan.newCharges.length || plan.newCosts.length || plan.addGarage || plan.addComparison)) {
    notify('Няма нови данни за добавяне.');clearBackupPreview();return;
  }
  if (!confirm(`Добавяне на данни от архива?\n\nНови зареждания: ${plan.newCharges.length}\nНови разходи: ${plan.newCosts.length}\nКонфликтите се пропускат, съществуващите данни не се заменят.\n\nПродължаваме ли?`)) return;
  await transaction([STORE_CHARGES,STORE_META],tx=>{
    const cStore=tx.objectStore(STORE_CHARGES),mStore=tx.objectStore(STORE_META);
    plan.newCharges.forEach(x=>cStore.add(x));
    plan.newCosts.forEach(x=>mStore.add({key:EXPENSE_PREFIX+x.id,value:x}));
    if (plan.addGarage) mStore.put({key:GARAGE_KEY,value:pendingBackup.incoming.garage});
    if (plan.addComparison) mStore.put({key:COMPARISON_KEY,value:pendingBackup.incoming.comparison});
  });
  const addedC=plan.newCharges.length,addedE=plan.newCosts.length;
  clearBackupPreview();
  await refresh();loadGarageForm();loadComparisonForm();
  notify(`Добавени: ${addedC} зареждания, ${addedE} разхода. Провери историята и направи нов backup.`);
}
/* --------------------- v0.4: legacy merger (preview-first) --------------------- */
let stagedLegacy = null;
const VALID_TARGETS = ['ev','ice','both','other'];
const TARGET_NAMES = {ev:'EV',ice:'ICE',both:'И двата',other:'Неуточнен'};
const normalizedText = s => String(s ?? '').trim().replace(/\s+/g,' ').toLowerCase();
function legacyBase(item) {
  const r=item.record;
  if(item.kind==='charge')return ['charge',r.date,r.kwh.toFixed(3),r.pricePerKwh.toFixed(4)].join('|');
  return ['cost',r.date,r.amount.toFixed(2),r.category].join('|');
}
function legacyKey(item,counter) {
  if(item.originalId) return `${item.source}:${item.kind}:id:${item.originalId}`;
  const r=item.record;
  const shape=item.kind==='charge'?[r.date,r.kwh,r.pricePerKwh,r.type,r.odometerMiles,r.notes]:[r.date,r.amount,r.category,r.target,r.title,r.notes];
  const raw=JSON.stringify(shape);let hash=2166136261;
  for(let i=0;i<raw.length;i++){hash^=raw.charCodeAt(i);hash=Math.imul(hash,16777619);}
  const first=`${item.source}:${item.kind}:row:${(hash>>>0).toString(16)}`;
  const count=(counter.get(first)||0)+1;counter.set(first,count);
  return `${first}:${count}`;
}
function dbSnapshot() {
  return JSON.stringify([
    ...charges.map(x=>`c:${x.id}:${x.updatedAt||''}`),
    ...expenses.map(x=>`e:${x.id}:${x.updatedAt||''}`)
  ].sort());
}
function legacyNearMatch(a,b,kind) {
  if (kind==='charge') {
    const nearKwh=Math.abs(a.kwh-b.kwh)<=Math.max(0.2,a.kwh*0.02);
    const nearPrice=Math.abs(a.pricePerKwh-b.pricePerKwh)<=0.03;
    const nearTotal=Math.abs(chargeTotal(a)-chargeTotal(b))<=0.50;
    const dayGap=Math.abs(new Date(a.date+'T12:00:00Z')-new Date(b.date+'T12:00:00Z'))/86400000;
    return (dayGap===0 && ((nearKwh && nearPrice)||(nearKwh && nearTotal))) || (dayGap===1 && nearKwh && nearPrice);
  }
  if(a.date!==b.date)return false;
  return Math.abs(a.amount-b.amount)<0.005 || (Math.abs(a.amount-b.amount)<=0.50 && normalizedText(a.title)===normalizedText(b.title));
}
function legacyDisplay(item) {
  const r=item.record;
  if(item.kind==='charge') return `⚡ ${fmtDate(r.date)} · ${r.kwh} kWh × £${r.pricePerKwh}/kWh · ${money(chargeTotal(r))}`;
  return `£ ${fmtDate(r.date)} · ${money(r.amount)} · ${COST_NAMES[r.category]} · ${TARGET_NAMES[r.target]}`;
}
function countLegacy() {
  if (!stagedLegacy) return;
  const add=stagedLegacy.items.filter(x=>x.choice==='add');
  const c=add.filter(x=>x.kind==='charge').length;
  const e=add.length-c;
  const skip=stagedLegacy.items.length-add.length;
  $('legacy-summary').textContent=`Открити ${stagedLegacy.items.length} записа · избрани ${c} зареждания и ${e} разхода · пропуснати ${skip}. Нищо не е записано досега.`;
  $('legacy-commit').disabled=!$('legacy-ack').checked || !add.length;
}
function renderLegacyPreview() {
  const root=$('legacy-review');root.replaceChildren();
  if(!stagedLegacy)return;
  const groups=[
    {key:'review',title:'⚠ За проверка / възможни дубликати',items:stagedLegacy.items.filter(x=>x.status!=='new'),open:true},
    {key:'new',title:'✓ Нови записи (можеш да ги прегледаш)',items:stagedLegacy.items.filter(x=>x.status==='new'),open:false}
  ];
  for(const g of groups) {
    const d=document.createElement('details');d.open=g.open;
    const sum=document.createElement('summary');sum.textContent=`${g.title}: ${g.items.length}`;d.append(sum);
    if(!g.items.length)d.append(element('p','small-note','Няма записи в тази група.'));
    for(const item of g.items) {
      const box=element('div','legacy-record');
      box.append(element('strong','',legacyDisplay(item)));
      box.append(element('small','',`${item.source==='old-json'?'Първо приложение (JSON)':item.source==='old-csv'?'Първо приложение (CSV)':'Второ приложение (CSV)'} · запис ${item.line}`));
      box.append(element('small','',item.kind==='charge'?`Тип: ${TYPE_NAMES[item.record.type] || item.record.type}`:`За автомобил: ${TARGET_NAMES[item.record.target] || item.record.target}`));
      box.append(element('small','',item.record.notes ? `Бележка: ${item.record.notes}` : 'Без бележка'));
      if (item.status!=='new')box.append(element('small','legacy-warning',item.reason));
      for(const warning of item.warnings)box.append(element('small','legacy-warning','⚠ '+warning));
      const select=element('select');select.setAttribute('aria-label','Решение за '+legacyDisplay(item));
      select.append(new Option('✅ Добави', 'add'),new Option('⏭ Пропусни','skip'));
      select.value=item.choice;
      select.addEventListener('change',()=>{item.choice=select.value;countLegacy();});
      box.append(select);d.append(box);
    }
    root.append(d);
  }
  $('legacy-preview-panel').hidden=false;
  countLegacy();
}
async function prepareLegacyPreview() {
  if (!window.EVLegacy || window.EVLegacy.version !== '0.4.2') throw Error('Импорт модулът е стар или не се е заредил. Обнови страницата онлайн. Не прави импорт.');
  const filenames=[...$('legacy-files').files];
  const pasted=$('legacy-json').value.trim();
  if(!filenames.length && !pasted)throw Error('Избери CSV / JSON файл или постави JSON текста от първото приложение.');
  if(filenames.length>10)throw Error('Избери до 10 файла наведнъж.');
  const results=[];
  for(const file of filenames) {
    if(file.size>12*1024*1024)throw Error(`Файлът ${file.name} е над 12 MB.`);
    const data=await file.text();
    if(file.name.toLowerCase().endsWith('.csv')) results.push(EVLegacy.parseCSV(data,file.name));
    else if(file.name.toLowerCase().endsWith('.json')) results.push(EVLegacy.parseOldJson(data));
    else throw Error('Използвай само .csv или .json файлове.');
  }
  if(pasted)results.push(EVLegacy.parseOldJson(pasted));
  const errors=results.flatMap(x=>x.errors.map(e=>`${x.filename}: ${e}`));
  if(errors.length)throw Error(`${errors.length} невалидни записа. Нищо не е заредено.\n${errors.slice(0,10).join('\n')}${errors.length>10?'\n…':''}`);
  const all=results.flatMap(x=>x.items);
  if(!all.length)throw Error('Файловете не съдържат записи.');
  if(all.length>2000)throw Error('Над 2000 записа. Импортирай файловете поотделно.');
  await refresh();
  const seen=new Map(),byDate=new Map(),keys=new Set(),counter=new Map();
  const remember=(kind,r)=>{const day=kind+':'+r.date;if(!byDate.has(day))byDate.set(day,[]);byDate.get(day).push(r);};
  for(const item of charges) {
    const base=legacyBase({kind:'charge',record:item});
    if(!seen.has(base))seen.set(base,[]);
    seen.get(base).push(item);remember('charge',item);
    if(item.importKey)keys.add('charge:'+item.importKey);
  }
  for(const item of expenses) {
    const base=legacyBase({kind:'cost',record:item});
    if(!seen.has(base))seen.set(base,[]);
    seen.get(base).push(item);remember('cost',item);
    if(item.importKey)keys.add('cost:'+item.importKey);
  }
  for(const item of all) {
    item.importKey=legacyKey(item,counter);
    const base=legacyBase(item);
    const similar=seen.get(base)||[];
    const sameDay=byDate.get(item.kind+':'+item.record.date)||[];
    const nearby=similar.length?[]:sameDay.filter(x=>legacyNearMatch(item.record,x,item.kind));
    const idSeen=keys.has(item.kind+':'+item.importKey);
    const warning=item.warnings.length>0;
    item.status=idSeen?'imported':similar.length?'similar':nearby.length?'near':warning?'warning':'new';
    item.reason=idSeen?'Този стар запис вече е импортиран.':similar.length?`Възможно повторение: същата дата и ${item.kind==='charge'?'kWh + цена':'сума + категория'}. Провери дали не е отделно събитие.`:nearby.length?'Възможно сходен запис (близки стойности/дата). Провери го ръчно.':warning?'Провери предупреждението за преобразуването.':'';
    item.choice=item.status==='new'?'add':'skip';
    if(!seen.has(base))seen.set(base,[]);
    seen.get(base).push(item.record);remember(item.kind,item.record);
    keys.add(item.kind+':'+item.importKey);
  }
  stagedLegacy={items:all,snapshot:dbSnapshot()};
  $('legacy-ack').checked=false;
  renderLegacyPreview();
  $('legacy-status').textContent=`Прегледът е готов. Първо провери възможните дубликати, после новите записи. Нищо не е записано.`;
  $('legacy-preview-panel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function commitLegacy() {
  if(!stagedLegacy)throw Error('Първо подготви прегледа.');
  if(!$('legacy-ack').checked)throw Error('Първо направи JSON backup и отбележи полето.');
  await refresh();
  if(dbSnapshot()!==stagedLegacy.snapshot)throw Error('Записите са променени след прегледа. Повтори проверката, преди да продължиш.');
  const selected=stagedLegacy.items.filter(x=>x.choice==='add');
  if(!selected.length)throw Error('Няма избрани записи за добавяне.');
  const c=selected.filter(x=>x.kind==='charge').length, e=selected.length-c;
  const risky=selected.filter(x=>x.status!=='new').length;
  if(!confirm(`EV Log 2.0 — последна проверка\n\nНови зареждания: ${c}\nНови други разходи: ${e}\nОт тях ${risky} бяха маркирани като възможни повторения/за проверка.\n\nСъществуващите записи НЯМА да се заменят.\nПродължаваме ли?`))return;
  const stamp=new Date().toISOString();
  const insert=selected.map(item=>{
    const record={...item.record,id:newId(),importKey:item.importKey,importedAt:stamp,createdAt:stamp,updatedAt:stamp};
    if(item.kind==='charge')validateCharge(record); else validateExpense(record);
    return {kind:item.kind,record};
  });
  await transaction([STORE_CHARGES,STORE_META],tx=>{
    const a=tx.objectStore(STORE_CHARGES),b=tx.objectStore(STORE_META);
    for(const item of insert) {
      if(item.kind==='charge')a.add(item.record);
      else b.add({key:EXPENSE_PREFIX+item.record.id,value:item.record});
    }
  });
  stagedLegacy=null;
  $('legacy-preview-panel').hidden=true;
  $('legacy-files').value='';$('legacy-json').value='';$('legacy-filenames').textContent='Няма избрани файлове';
  await refresh();
  $('legacy-status').textContent=`✅ Добавени ${c} зареждания и ${e} други разхода. Създай нов пълен JSON backup от EV Log 2.0.`;
  notify(`Добавени ${c} зареждания и ${e} разхода. Направи нов backup.`);
}
function verifyLegacyModule() {
  const imported = window.EVLegacy;
  const ok = Boolean(imported && imported.version === '0.6.0');
  $('legacy-module-check').textContent = ok
    ? '✅ Импорт модул v0.6.0 зареден (непроменен във v0.7) · разпознава „Домашно (Home)“.'
    : '⚠ Импорт модулът не е v0.6.0. Не потвърждавай импорт. Презареди страницата онлайн.';
  $('legacy-preview').disabled = !ok;
}
function bindLegacyEvents() {
  $('legacy-files').addEventListener('change',()=>{
    const names=[...$('legacy-files').files].map(x=>x.name);
    $('legacy-filenames').textContent=names.length?names.join(', '):'Няма избрани файлове';
    stagedLegacy=null;$('legacy-preview-panel').hidden=true;
  });
  $('legacy-json').addEventListener('input',()=>{stagedLegacy=null;$('legacy-preview-panel').hidden=true;});
  $('legacy-preview').addEventListener('click',async()=>{
    $('legacy-preview').disabled=true;stagedLegacy=null;$('legacy-preview-panel').hidden=true;
    try{await prepareLegacyPreview();}
    catch(e){$('legacy-status').textContent='❌ '+e.message;notify('Неуспешна проверка — виж подробностите.',true);}
    finally{$('legacy-preview').disabled=false;}
  });
  $('legacy-ack').addEventListener('change',countLegacy);
  $('legacy-commit').addEventListener('click',async()=>{
    $('legacy-commit').disabled=true;
    try{await commitLegacy();}
    catch(e){$('legacy-status').textContent='❌ '+e.message;notify('Импортът е спрян: '+e.message,true);}
    finally{if(stagedLegacy)countLegacy();}
  });
  $('legacy-reset').addEventListener('click',()=>{
    stagedLegacy=null;$('legacy-preview-panel').hidden=true;$('legacy-status').textContent='Прегледът е отменен. Данните не са променени.';
  });
}
/* --------------------------- end legacy merger --------------------------- */

/* ---------------------- v0.5: read-only history audit --------------------- */
let auditSnapshot = '';
function auditCounts() {
  const allCharges=charges.reduce((s,x)=>s+chargeTotal(x),0);
  const allCosts=expenses.reduce((s,x)=>s+x.amount,0);
  const sources=new Map();
  for(const x of [...charges,...expenses]) {
    const key=x.importSource || 'manual';
    sources.set(key,(sources.get(key)||0)+1);
  }
  return {allCharges,allCosts,sources};
}
function auditSourceName(key) {
  return ({'cloud-csv':'Второ приложение (CSV)','old-json':'Първо приложение (JSON)','old-csv':'Първо приложение (CSV)','manual':'Ръчно / архив EV Log 2.0'})[key]||key;
}
function renderAuditOverview() {
  const {allCharges,allCosts,sources}=auditCounts();
  const root=$('audit-overview');root.replaceChildren();
  const lines=[
    `${charges.length} зареждания · общо ${money(allCharges)}`,
    `${expenses.length} други разхода · общо ${money(allCosts)}`,
    `Всички разходи: ${money(allCharges+allCosts)}`
  ];
  for(const line of lines)root.append(element('div','audit-summary-row',line));
  const sourceBox=element('div','audit-sources');
  sourceBox.append(element('strong','', 'Произход на записите (зареждания + разходи):'));
  for(const [source,n] of [...sources].sort((a,b)=>b[1]-a[1]))sourceBox.append(element('div','',`${auditSourceName(source)}: ${n}`));
  root.append(sourceBox);
  if(auditSnapshot && auditSnapshot!==dbSnapshot()) {
    auditSnapshot='';$('audit-groups').replaceChildren();
    $('audit-status').textContent='Записите са променени. Натисни „Провери“ за нова проверка.';
  }
}
function findAuditGroups() {
  // Screening only: two legitimate sessions may share date, kWh and tariff.
  // Never delete or auto-select any result.
  const groups=new Map();
  function add(kind,record,key) {
    const code=kind+'|'+key;
    if(!groups.has(code))groups.set(code,{kind,items:[]});
    groups.get(code).items.push(record);
  }
  for(const r of charges)add('charge',r,[r.date,r.kwh.toFixed(3),r.pricePerKwh.toFixed(4)].join('|'));
  for(const r of expenses)add('cost',r,[r.date,r.amount.toFixed(2),r.category].join('|'));
  return [...groups.values()].filter(g=>g.items.length>1)
    .sort((a,b)=>b.items[0].date.localeCompare(a.items[0].date)||b.items.length-a.items.length);
}
function auditLabel(group) {
  const r=group.items[0];
  return group.kind==='charge'
    ? `${fmtDate(r.date)} · ${r.kwh} kWh × £${r.pricePerKwh}/kWh · ${money(chargeTotal(r))}`
    : `${fmtDate(r.date)} · ${money(r.amount)} · ${COST_NAMES[r.category]||r.category}`;
}
function auditRecordLabel(kind,r) {
  const detail=kind==='charge'
    ? `${TYPE_NAMES[r.type]||r.type} · ${r.station||'без станция'} · ${r.odometerMiles??'–'} mi`
    : `${r.title} · ${TARGET_NAMES[r.target||'ev']||r.target}`;
  return `${detail} · ${auditSourceName(r.importSource||'manual')}${r.notes?' · '+r.notes:''}`;
}
function runAudit() {
  const groups=findAuditGroups();
  const root=$('audit-groups');root.replaceChildren();
  const totalRecords=groups.reduce((sum,g)=>sum+g.items.length,0);
  $('audit-status').textContent=groups.length
    ? `⚠ ${groups.length} групи с еднаква дата и kWh/цена или сума/категория (${totalRecords} записа общо). Това са ВЪЗМОЖНИ, не доказани дубликати.`
    : '✅ Няма намерени записи с еднаква дата и ключови стойности. Това не изключва всички възможни повторения.';
  if(!groups.length){auditSnapshot=dbSnapshot();return;}
  const limited=groups.slice(0,150);
  for (const group of limited) {
    const details=document.createElement('details');details.className='audit-group';
    const summary=document.createElement('summary');
    summary.textContent=`${group.items.length} записа · ${auditLabel(group)}`;
    details.append(summary);
    for(const item of group.items){
      const node=element('div','audit-record',auditRecordLabel(group.kind,item));
      details.append(node);
    }
    const jump=element('button','secondary audit-jump','Виж записите за тази дата');jump.type='button';
    jump.addEventListener('click',()=>{
      if(group.kind==='charge'){
        $('history-filter').value=group.items[0].date.slice(0,7);
        $('history-search').value=group.items[0].date;
        renderHistory();navigate('history');
      } else {
        $('costs-filter').value=group.items[0].date.slice(0,7);
        $('cost-target-filter').value='all';
        $('costs-search').value=group.items[0].date;
        renderCosts();navigate('costs');
      }
    });
    details.append(jump);root.append(details);
  }
  if(groups.length>limited.length)root.append(element('p','small-note',`Показани са първите ${limited.length} групи. Използвай CSV експорта за пълна проверка.`));
  auditSnapshot=dbSnapshot();
}
function csvSafe(value) {
  let s=String(value??'');
  // Prevent CSV/Excel formula execution when user-entered text is opened in a spreadsheet.
  if(/^\s*[=+@-]/.test(s) && !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function downloadCsv(rows,filename) {
  const data='\uFEFF'+rows.map(row=>row.map(csvSafe).join(',')).join('\r\n')+'\r\n';
  const blob=new Blob([data],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
/* v1.5 — read-only CSV reports. Uses the same periodScope() as visible analytics.
   The two-month comparison is intentionally independent from this period. */
function periodExportTag(scope) {
  if (scope.period==='custom') return `from-${customRange.from}-to-${customRange.to}`;
  if (scope.period==='all') return 'all-history';
  return `last-${scope.period}-months`;
}
function periodDetailsCsvRows(scope=periodScope()) {
  const header=['date','record_type','vehicle','type_or_category','description','kwh','price_gbp_per_kwh','total_gbp','odometer_miles','notes','import_source'];
  const records=[];
  for(const x of scope.selectedCharges) {
    records.push({date:x.date,id:x.id,row:[x.date,'charging','EV',x.type,x.station||'',x.kwh,x.pricePerKwh,chargeTotal(x).toFixed(2),x.odometerMiles??'',x.notes||'',x.importSource||'manual']});
  }
  for(const x of scope.selectedExpenses) {
    records.push({date:x.date,id:x.id,row:[x.date,'expense',x.target||'ev',x.category,x.title,x.kwh??'', '',roundPence(x.amount).toFixed(2),x.odometerMiles??'',x.notes||'',x.importSource||'manual']});
  }
  records.sort((a,b)=>b.date.localeCompare(a.date)||String(a.id).localeCompare(String(b.id)));
  return [header,...records.map(x=>x.row)];
}
function periodMonthsCsvRows(scope=periodScope()) {
  const header=['month','charging_count','kwh','charging_gbp','average_gbp_per_kwh','expense_count','other_expenses_gbp','total_gbp'];
  // The chart may show only the last 36 months. Exports must never silently
  // drop older months with data when "All" or a long date range is selected.
  const dataMonths=[...scope.selectedCharges,...scope.selectedExpenses].map(x=>x.date.slice(0,7));
  const months=[...new Set([...scope.months,...dataMonths])].sort();
  const result=[header];
  for(const month of months) {
    const cs=scope.selectedCharges.filter(x=>x.date.startsWith(month));
    const ex=scope.selectedExpenses.filter(x=>x.date.startsWith(month));
    const kwh=cs.reduce((sum,x)=>sum+x.kwh,0);
    const charging=cs.reduce((sum,x)=>sum+chargeTotal(x),0);
    const other=ex.reduce((sum,x)=>sum+x.amount,0);
    result.push([month,cs.length,Number(kwh.toFixed(3)),roundPence(charging).toFixed(2),kwh>0?(charging/kwh).toFixed(4):'',ex.length,roundPence(other).toFixed(2),roundPence(charging+other).toFixed(2)]);
  }
  return result;
}
function monthComparisonCsvRows(aMonth,bMonth) {
  if(!monthValid(aMonth) || !monthValid(bMonth))throw Error('Избери два валидни месеца.');
  const a=compareMonthValues(aMonth),b=compareMonthValues(bMonth);
  const fields=['side','month','charging_count','kwh','charging_gbp','average_gbp_per_kwh','expense_count','other_expenses_gbp','total_gbp'];
  const row=(side,x)=>[side,x.month,x.chargeCount,Number(x.kwh.toFixed(3)),roundPence(x.charging).toFixed(2),x.kwh>0?(x.charging/x.kwh).toFixed(4):'',x.expenseCount,roundPence(x.other).toFixed(2),roundPence(x.total).toFixed(2)];
  // A difference in average tariffs is not a meaningful "overall tariff".
  const delta=['B_minus_A','',b.chargeCount-a.chargeCount,Number((b.kwh-a.kwh).toFixed(3)),roundPence(b.charging-a.charging).toFixed(2),'',b.expenseCount-a.expenseCount,roundPence(b.other-a.other).toFixed(2),roundPence(b.total-a.total).toFixed(2)];
  return [fields,row('A',a),row('B',b),delta];
}
function exportPeriodCsv(kind) {
  const scope=periodScope();
  const rows=kind==='details'?periodDetailsCsvRows(scope):periodMonthsCsvRows(scope);
  const kindName=kind==='details'?'entries':'monthly';
  downloadCsv(rows,`EV-Log-2-${kindName}-${periodExportTag(scope)}-${today()}.csv`);
  notify(`CSV отчетът е подготвен (${rows.length-1} реда). Провери Downloads. JSON Backup остава отделен.`);
}
function exportComparisonCsv() {
  const a=$('stats-month-a').value,b=$('stats-month-b').value;
  const rows=monthComparisonCsvRows(a,b);
  downloadCsv(rows,`EV-Log-2-compare-${a}-vs-${b}.csv`);
  notify('Сравнението е подготвено като CSV. Провери Downloads.');
}
function renderPeriodExportScope(scope) {
  $('stats-export-scope').textContent=`Избран период: ${scope.period==='custom' ? `${fmtDate(customRange.from)} – ${fmtDate(customRange.to)}` : scope.period==='all' ? 'всички записи' : `последните ${scope.period} календарни месеца`} · ${scope.selectedCharges.length} зареждания · ${scope.selectedExpenses.length} други разхода.`;
}

function exportAuditCsv(kind) {
  if(kind==='charge'){
    const rows=[['date','kwh','price_per_kwh','total_gbp','type','odometer_miles','station','note','import_source']];
    for(const r of charges)rows.push([r.date,r.kwh,r.pricePerKwh,chargeTotal(r),r.type,r.odometerMiles??'',r.station,r.notes,r.importSource||'manual']);
    downloadCsv(rows,`EV-Log-2-charges-${today()}.csv`);
  } else {
    const rows=[['date','amount_gbp','category','target','title','odometer_miles','note','import_source']];
    for(const r of expenses)rows.push([r.date,r.amount,r.category,r.target||'ev',r.title,r.odometerMiles??'',r.notes,r.importSource||'manual']);
    downloadCsv(rows,`EV-Log-2-costs-${today()}.csv`);
  }
  notify('CSV файлът е подготвен. Провери Downloads. За възстановяване използвай JSON backup.');
}
/* ------------------------------ end audit -------------------------------- */


async function onRecordClick(event,kind) {
  const button=event.target.closest('button[data-action]');
  if (!button) return;
  const id=button.dataset.id;
  if (button.dataset.action==='reuse' && kind==='charge') return reuseChargeStation(charges.find(x=>x.id===id));
  if (button.dataset.action==='edit') return kind==='charge'?editCharge(id):openExpenseForm(id);
  const item=(kind==='charge'?charges:expenses).find(x=>x.id===id);
  if (!item) return;
  if (!confirm(`Да изтрия ${kind==='charge'?'зареждането':'разхода'} от ${fmtDate(item.date)} (${money(kind==='charge'?chargeTotal(item):item.amount)})?`)) return;
  button.disabled=true;
  try {
    if (kind==='charge') await saveCharge(item,true); else await saveExpense(item,true);
    await refresh();notify('Записът е изтрит.');
  } catch (error) {button.disabled=false;notify(error.message,true);}
}
function updatePwaStatus() {
  const standalone=matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
  const secure=location.protocol==='https:' || location.hostname==='localhost';
  const sw=navigator.serviceWorker;
  const controlled=!!sw?.controller;
  const text=standalone?'Приложението вече работи в самостоятелен режим.':
    `Защитена връзка: ${secure?'да':'не'} · Offline worker: ${controlled?'активен':sw?'изчаква активиране / проверка':'неподдържан'} · ${installEvent?'Инсталиране е налично.':'Ако няма бутон за инсталация, опитай менюто ⋮ в Chrome.'}`;
  $('pwa-status').textContent=text;
  $('install-cta').hidden=!installEvent || standalone;
}
function attachEvents() {
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.go)));
  $('quick-add').addEventListener('click',()=>{resetChargeForm();navigate('charge');});
  $('quick-expense').addEventListener('click',()=>openExpenseForm());
  $('month-prev').addEventListener('click',()=>moveOverviewMonth(-1));
  $('month-next').addEventListener('click',()=>moveOverviewMonth(1));
  $('month-today').addEventListener('click',()=>{overviewMonth=today().slice(0,7);renderHome();});
  $('type').addEventListener('change',defaultPrice);
  $('station').addEventListener('input',renderStationTariffSuggestion);
  $('use-station-tariff').addEventListener('click',()=>{
    if(!suggestedTariff)return;
    $('type').value=suggestedTariff.type;
    $('price').value=String(suggestedTariff.pricePerKwh);
    renderStationTariffSuggestion();updatePreview();
    notify('Приложих последната записана цена. Провери дали още е актуална.');
  });
  for(const field of ['kwh','price','odometer','date'])$(field).addEventListener('input',updatePreview);
  $('charge-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-charge');
    try {
      const item=chargeFromForm();
      const warnings=chargeEntryWarnings(item);
      if(warnings.length && !confirm(`Провери следното преди запис:\n\n${warnings.map(w=>'• '+w).join('\n')}\n\nСигурен ли си, че записът е правилен?`))return;
      if(!confirmExactDuplicate(item,'charge'))return;
      b.disabled=true;await saveCharge(item);await refresh();resetChargeForm();navigate('home');notify('Зареждането е запазено.');
    }
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('same-as-last').addEventListener('click',()=>{
    if(!charges.length)return notify('Няма предишно зареждане.',true);
    reuseChargeStation(charges[0]); // Never copy last session's kWh/odometer/notes.
  });
  $('cancel-edit').addEventListener('click',resetChargeForm);
  $('history-filter').addEventListener('change',renderHistory);
  $('history-type-filter').addEventListener('change',renderHistory);
  $('history-clear').addEventListener('click',()=>{
    $('history-filter').value='all';
    $('history-type-filter').value='all';
    $('history-search').value='';
    renderHistory();
  });
  $('history-search').addEventListener('input',renderHistory);
  $('history-list').addEventListener('click',event=>onRecordClick(event,'charge'));
  $('new-expense').addEventListener('click',()=>openExpenseForm());
  $('cancel-expense').addEventListener('click',()=>{$('expense-form').hidden=true;resetExpenseForm();});
  $('expense-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-expense');
    try {const item=expenseFromForm();
      if(item.category==='fuel' && item.target!=='ice' && !confirm('Горивото обикновено е разход за ICE. Избрано е друго предназначение. Сигурен ли си?'))return;
      if(!confirmExactDuplicate(item,'cost'))return;b.disabled=true;await saveExpense(item);await refresh();resetExpenseForm();$('expense-form').hidden=true;notify('Разходът е запазен.');}
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('costs-filter').addEventListener('change',renderCosts);
  $('costs-search').addEventListener('input',renderCosts);
  $('cost-target-filter').addEventListener('change',renderCosts);
  // Dates and month selectors affect only the analysis view (no database writes).
  $('stats-date-from').value=customRange.from;
  $('stats-date-to').value=customRange.to;
  const thisMonth=today().slice(0,7);
  const previousMonth=localDate(new Date(new Date().getFullYear(),new Date().getMonth()-1,1)).slice(0,7);
  $('stats-month-a').value=previousMonth;
  $('stats-month-b').value=thisMonth;
  $('stats-period').addEventListener('change',renderStats);
  for(const id of ['stats-date-from','stats-date-to']) $(id).addEventListener('input',()=>{
    if($('stats-period').value==='custom') $('stats-range-status').textContent='Датите са променени. Натисни „Покажи периода“, за да обновиш статистиката.';
  });
  $('stats-apply-range').addEventListener('click',applyCustomRange);
  $('stats-month-a').addEventListener('change',renderMonthComparison);
  $('stats-month-b').addEventListener('change',renderMonthComparison);
  $('export-period-details').addEventListener('click',()=>exportPeriodCsv('details'));
  $('export-period-months').addEventListener('click',()=>exportPeriodCsv('months'));
  $('export-month-comparison').addEventListener('click',()=>{try{exportComparisonCsv();}catch(error){notify(error.message,true);}});
  $('export-actual-costs').addEventListener('click',()=>{try{exportActualCostsCsv();}catch(error){notify(error.message,true);}});
  $('expense-category').addEventListener('change',()=>{
    if($('expense-category').value==='fuel' && $('expense-target').value==='ev') {
      $('expense-target').value='ice';
      notify('Избрах ICE за горивото. Провери автомобила преди запис.');
    }
  });
  renderMonthComparison();
  $('compare-price-mode').addEventListener('change',()=>{updateManualPriceVisibility();try{renderComparison(comparisonFromForm());}catch(_){}});
  $('comparison-form').addEventListener('input',()=>{try{renderComparison(comparisonFromForm());}catch(_){}});
  $('comparison-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-comparison');
    try {const value=comparisonFromForm();b.disabled=true;
      await transaction([STORE_META],tx=>tx.objectStore(STORE_META).put({key:COMPARISON_KEY,value}));
      await refresh();notify('Настройките за сравнение са запазени.');
    } catch(error) {notify(error.message,true);}finally{b.disabled=false;}
  });
  $('costs-list').addEventListener('click',event=>onRecordClick(event,'cost'));
  $('garage-use-last-odo').addEventListener('click',()=>{
    const last=charges.find(x=>Number.isInteger(x.odometerMiles) && x.odometerMiles>=0);
    if(!last) { notify('Няма зареждане със записан километраж.',true);return; }
    const field=$('vehicle-odo');
    if (field.value.trim() && field.value.trim()!==String(last.odometerMiles) && !confirm(`Да заменя ${field.value} mi с ${last.odometerMiles} mi от ${fmtDate(last.date)}?`)) return;
    field.value=String(last.odometerMiles);
    $('garage-odo-hint').textContent=`Последно зареждане с километраж: ${fmtDate(last.date)} · ${last.odometerMiles.toLocaleString('en-GB')} mi. Натисни „Запази Garage“, за да го запишеш.`;
  });
  $('garage-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-garage');
    try {const profile=garageFromForm();b.disabled=true;await saveGarage(profile);await refresh();loadGarageForm();notify('Garage е запазен.');}
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('export-backup').addEventListener('click',()=>downloadBackup().catch(e=>notify(e.message,true)));
  $('share-backup').hidden=!supportsFileSharing();
  $('share-backup').addEventListener('click',()=>shareBackup().catch(e=>notify(e.message,true)));
  $('audit-run').addEventListener('click',runAudit);
  $('export-charges-csv').addEventListener('click',()=>exportAuditCsv('charge'));
  $('export-costs-csv').addEventListener('click',()=>exportAuditCsv('cost'));
  $('import-backup').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try {await previewBackupFile(file);}
    catch(error){clearBackupPreview();$('selected-file').textContent='❌ '+error.message;notify(error.message,true);}
    finally{event.target.value='';}
  });
  $('backup-ack').addEventListener('change',()=>{
    $('backup-commit').disabled=!$('backup-ack').checked || !pendingBackup?.canRestore;
  });
  $('backup-cancel').addEventListener('click',clearBackupPreview);
  $('backup-commit').addEventListener('click',async()=>{
    const b=$('backup-commit');if(b.disabled)return;b.disabled=true;
    try{await commitFullBackup();}catch(error){notify(error.message,true);}
    finally{if(pendingBackup)b.disabled=!$('backup-ack').checked || !pendingBackup.canRestore;}
  });
  bindLegacyEvents();
  $('install-cta').addEventListener('click',async()=>{
    if(!installEvent)return;
    const event=installEvent;installEvent=null;updatePwaStatus();
    try {await event.prompt();await event.userChoice;}catch(error){console.warn('PWA install:',error);}
    updatePwaStatus();
  });
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installEvent=event;updatePwaStatus();});
  window.addEventListener('appinstalled',()=>{installEvent=null;updatePwaStatus();notify('Приложението е инсталирано.');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().then(loadGarageForm).catch(e=>notify(e.message,true));});
}
async function start() {
  try {
    if (!('indexedDB' in window)) throw Error('Браузърът не поддържа IndexedDB.');
    db=await openDb();
    db.onversionchange=()=>{db.close();notify('Базата е обновена в друг прозорец. Презареди страницата.',true);};
    await refresh();resetChargeForm();resetExpenseForm();loadGarageForm();loadComparisonForm();attachEvents();
    verifyLegacyModule();
    updatePwaStatus();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange',updatePwaStatus);
      try {await navigator.serviceWorker.register('./sw.js',{scope:'./'});}
      catch(error){console.warn('Service Worker:',error);notify('Offline режимът не можа да се активира.',true);}
      updatePwaStatus();
    }
  } catch (error) {
    console.error(error);notify(`Базата не е достъпна: ${error.message}`,true);
    $('main').insertAdjacentElement('afterbegin',element('p','empty','Не може да се отвори локалната база. Не въвеждай нови данни, докато проблемът не е решен. Не изтривай данните на Chrome.'));
  }
}
start();
