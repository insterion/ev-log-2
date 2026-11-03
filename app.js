'use strict';
/* EV Log 2.0 v0.3
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
const COST_NAMES = { insurance:'Insurance', mot:'MOT', tax:'Road tax / VED', service:'Service', tyres:'Гуми', repair:'Ремонт', parking:'Паркинг', cleaning:'Миене / грижа', other:'Друго' };
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
let expenseEditingId = null;
let toastTimeout;
let installEvent = null;

function defaultComparison() {
  return {distanceMiles:100,efficiencyMiKwh:3.5,iceMpgUk:45,fuelPriceLitre:1.50,priceMode:'history',manualPriceKwh:0.56};
}
function emptyGarage() {
  return {make:'',model:'',year:null,registration:'',odometerMiles:null,notes:'',due:{mot:'',insurance:'',tax:'',service:''}};
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
  return raw;
}
function garageIsEmpty(profile) {
  return !profile.make && !profile.model && !profile.registration && profile.year === null && profile.odometerMiles === null && !profile.notes && !Object.values(profile.due).some(Boolean);
}
function chargeFromForm() {
  const prior = chargeEditingId ? charges.find(x => x.id === chargeEditingId) : null;
  if ($('kwh').value.trim() === '' || $('price').value.trim() === '') throw Error('Попълни kWh и цена.');
  const odo = $('odometer').value.trim();
  return validateCharge({
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
    title:$('expense-title').value.trim(),odometerMiles:odo === '' ? null : Number(odo),
    notes:$('expense-notes').value.trim(),createdAt:prior?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString()
  });
}
function garageFromForm() {
  const year = $('vehicle-year').value.trim();
  const odo = $('vehicle-odo').value.trim();
  const due = {};
  for (const key of Object.keys(DUE_NAMES)) due[key] = $(`due-${key}`).value;
  return validateGarage({
    make:$('vehicle-make').value.trim(),model:$('vehicle-model').value.trim(),
    year:year === '' ? null : Number(year),registration:$('vehicle-reg').value.trim().toUpperCase(),
    odometerMiles:odo === '' ? null : Number(odo),notes:$('vehicle-notes').value.trim(),due
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
}
function defaultPrice() {
  const type = $('type').value;
  const last = charges.find(r => r.type === type);
  $('price').value=String(last ? last.pricePerKwh : PRICE_HINTS[type]);
  updatePreview();
}
function updatePreview() {
  const kwh = Number($('kwh').value);
  const price = Number($('price').value);
  $('preview-total').textContent = Number.isFinite(kwh*price) && kwh > 0 && price >= 0 ? money(kwh*price) : '£0.00';
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
  updatePreview(); navigate('charge');
}
function resetExpenseForm() {
  expenseEditingId=null;
  $('expense-form').reset();
  $('expense-date').value=today();
  $('expense-category').value='service';
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
    $('expense-category').value=item.category;
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
}
function actionButtons(card,type,id) {
  const row=element('div','record-actions');
  const edit=element('button','','Редактирай'); edit.type='button'; edit.dataset.action='edit'; edit.dataset.id=id;
  const del=element('button','danger','Изтрий'); del.type='button'; del.dataset.action='delete'; del.dataset.id=id;
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
  [COST_NAMES[item.category],...(item.odometerMiles===null?[]:[item.odometerMiles.toLocaleString('en-GB')+' mi'])].forEach(t=>chips.append(element('span','',t)));
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
function renderHome() {
  const current=today().slice(0,7);
  const monthCharges=charges.filter(x=>x.date.slice(0,7)===current);
  const monthExpenses=expenses.filter(x=>x.date.slice(0,7)===current);
  const charging=monthCharges.reduce((sum,x)=>sum+chargeTotal(x),0);
  const cost=monthExpenses.reduce((sum,x)=>sum+x.amount,0);
  const kwh=monthCharges.reduce((sum,x)=>sum+x.kwh,0);
  $('month-label').textContent=monthName(current);
  $('month-cost').textContent=money(charging);
  $('month-kwh').textContent=kwh.toFixed(2)+' kWh';
  $('month-expense').textContent=money(cost);
  $('month-expense-count').textContent=`${monthExpenses.length} записа`;
  $('month-all').textContent=money(charging+cost);
  $('month-price').textContent=kwh>0?money(charging/kwh):'—';
  $('month-count').textContent=String(monthCharges.length);
  renderList($('recent-list'),charges.slice(0,3),chargeCard,false,'Все още няма зареждания.');
  renderList($('recent-costs'),expenses.slice(0,2),expenseCard,false,'Все още няма други разходи.');
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
  const items=selected==='all'?charges:charges.filter(x=>x.date.startsWith(selected));
  $('history-summary').textContent=`${items.length} записа`;
  $('history-sum').textContent=money(items.reduce((sum,x)=>sum+chargeTotal(x),0));
  renderList($('history-list'),items,chargeCard,true);
}
function renderCosts() {
  renderMonthFilter($('costs-filter'),expenses);
  const selected=$('costs-filter').value;
  const items=selected==='all'?expenses:expenses.filter(x=>x.date.startsWith(selected));
  $('costs-summary').textContent=`${items.length} разхода`;
  $('costs-sum').textContent=money(items.reduce((sum,x)=>sum+x.amount,0));
  renderList($('costs-list'),items,expenseCard,true,'Няма други разходи за периода.');
}
function daysUntil(date) {
  const start=new Date(`${today()}T12:00:00`);
  const end=new Date(`${date}T12:00:00`);
  return Math.round((end-start)/86400000);
}
function renderGarage() {
  const box=$('garage-alerts'); box.replaceChildren();
  const deadlines=Object.entries(DUE_NAMES).filter(([key])=>garage.due[key]).map(([key,label])=>({key,label,date:garage.due[key],days:daysUntil(garage.due[key])})).sort((a,b)=>a.days-b.days);
  if (!deadlines.length) {
    box.append(element('p','small-note','Няма въведени срокове. Те не се проверяват от DVLA или застраховател — въведи ги по документи.'));
    return;
  }
  deadlines.forEach(item => {
    const status=item.days<0?'Изтекъл срок':item.days===0?'Днес':item.days<=30?`След ${item.days} дни`:'Предстоящ';
    const alert=element('div',`due-item ${item.days<0?'expired':item.days<=30?'near':'normal'}`);
    alert.append(element('strong','',`${item.label} · ${fmtDate(item.date)}`),element('span','',status));
    box.append(alert);
  });
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
  const count=period==='all'?null:Number(period);
  const first=count===null?'':localDate(new Date(new Date().getFullYear(),new Date().getMonth()-count+1,1)).slice(0,7);
  const inPeriod=x=>count===null || (x.date.slice(0,7)>=first && x.date.slice(0,7)<=now);
  const selectedCharges=charges.filter(inPeriod);
  const selectedExpenses=expenses.filter(inPeriod);
  let months=[];
  if (count===null) {
    months=[...new Set([...selectedCharges,...selectedExpenses].map(x=>x.date.slice(0,7)))].sort();
    if(months.length>36)months=months.slice(-36);
  } else {
    for(let i=count-1;i>=0;i--) months.push(localDate(new Date(new Date().getFullYear(),new Date().getMonth()-i,1)).slice(0,7));
  }
  return {selectedCharges,selectedExpenses,months,period};
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
function renderStats() {
  const scope=periodScope();
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
  renderComparison(comparison,scope);
}

function renderAll() {
  renderHome();renderHistory();renderCosts();renderGarage();renderStats();
  $('backup-count').textContent=`В момента: ${charges.length} зареждания, ${expenses.length} други разхода${garageIsEmpty(garage)?', Garage е празен.':', Garage е попълнен.'}`;
}
function chargeSignature(x) {return [x.date,x.odometerMiles??'',x.type,x.kwh,x.pricePerKwh,x.station.trim().toLowerCase(),x.notes.trim().toLowerCase()].join('\u001f');}
function expenseSignature(x) {return [x.date,x.amount,x.category,x.title.trim().toLowerCase(),x.odometerMiles??'',x.notes.trim().toLowerCase()].join('\u001f');}
function validateBackup(data) {
  if (!data || data.format!==BACKUP_FORMAT || ![1,2].includes(data.version) || !Array.isArray(data.charges)) throw Error('Файлът не е валиден архив от EV Log 2.0 (v0.1 или v0.2).');
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
async function downloadBackup() {
  await refresh();
  const payload={format:BACKUP_FORMAT,version:2,exportedAt:new Date().toISOString(),charges:charges.map(x=>({...x})),costs:expenses.map(x=>({...x})),garage:JSON.parse(JSON.stringify(garage)),comparison:{...comparison}};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`EV-Log-2-full-backup-${today()}.json`;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  notify('Архивът е подготвен. Провери Downloads и го запази на безопасно място.');
}
async function importBackup(file) {
  if (file.size>30*1024*1024) throw Error('Архивът е твърде голям (макс. 30 MB).');
  let obj;
  try {obj=JSON.parse(await file.text());} catch (_) {throw Error('Файлът не е валиден JSON.');}
  const incoming=validateBackup(obj);
  await refresh();
  const chargeIds=new Set(charges.map(x=>x.id));
  const chargeFingerprints=new Set(charges.map(chargeSignature));
  const costIds=new Set(expenses.map(x=>x.id));
  const costFingerprints=new Set(expenses.map(expenseSignature));
  const newCharges=[],newCosts=[];
  for (const item of incoming.charges) {
    const sig=chargeSignature(item);
    if (!chargeIds.has(item.id) && !chargeFingerprints.has(sig)) {newCharges.push(item);chargeIds.add(item.id);chargeFingerprints.add(sig);}
  }
  for (const item of incoming.costs) {
    const sig=expenseSignature(item);
    if (!costIds.has(item.id) && !costFingerprints.has(sig)) {newCosts.push(item);costIds.add(item.id);costFingerprints.add(sig);}
  }
  const addGarage=incoming.garage && garageIsEmpty(garage) && !garageIsEmpty(incoming.garage);
  const addComparison=!!incoming.comparison && !comparisonStored;
  const skippedCharges=incoming.charges.length-newCharges.length;
  const skippedCosts=incoming.costs.length-newCosts.length;
  if (!newCharges.length && !newCosts.length && !addGarage && !addComparison) {
    notify(`Няма нови записи. Пропуснати: ${skippedCharges} зареждания и ${skippedCosts} разходи.`);return;
  }
  if (!confirm(`Импорт от EV Log 2.0\n\nНови зареждания: ${newCharges.length} (пропуснати ${skippedCharges})\nНови разходи: ${newCosts.length} (пропуснати ${skippedCosts})\nGarage: ${addGarage?'ще се добави':'без промяна'}\nEV/ICE настройки: ${addComparison?'ще се добавят':'без промяна'}\n\nПродължаваме ли?`)) return;
  await transaction([STORE_CHARGES,STORE_META],tx=>{
    const cStore=tx.objectStore(STORE_CHARGES),mStore=tx.objectStore(STORE_META);
    newCharges.forEach(x=>cStore.add(x));
    newCosts.forEach(x=>mStore.add({key:EXPENSE_PREFIX+x.id,value:x}));
    if (addGarage) mStore.put({key:GARAGE_KEY,value:incoming.garage});
    if (addComparison) mStore.put({key:COMPARISON_KEY,value:incoming.comparison});
  });
  await refresh();loadGarageForm();loadComparisonForm();
  notify(`Импортирани: ${newCharges.length} зареждания, ${newCosts.length} разходи${addGarage?' и Garage':''}.`);
}
async function onRecordClick(event,kind) {
  const button=event.target.closest('button[data-action]');
  if (!button) return;
  const id=button.dataset.id;
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
  $('type').addEventListener('change',defaultPrice);
  $('kwh').addEventListener('input',updatePreview);$('price').addEventListener('input',updatePreview);
  $('charge-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-charge');
    try {const item=chargeFromForm();b.disabled=true;await saveCharge(item);await refresh();resetChargeForm();navigate('home');notify('Зареждането е запазено.');}
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('same-as-last').addEventListener('click',()=>{
    if (!charges.length) return notify('Няма предишно зареждане.',true);
    const last=charges[0];resetChargeForm();
    $('type').value=last.type;$('kwh').value=last.kwh;$('price').value=last.pricePerKwh;
    $('station').value=last.station;$('notes').value=last.notes;updatePreview();
    notify('Попълнено от последното. Провери и запази.');
  });
  $('cancel-edit').addEventListener('click',resetChargeForm);
  $('history-filter').addEventListener('change',renderHistory);
  $('history-list').addEventListener('click',event=>onRecordClick(event,'charge'));
  $('new-expense').addEventListener('click',()=>openExpenseForm());
  $('cancel-expense').addEventListener('click',()=>{$('expense-form').hidden=true;resetExpenseForm();});
  $('expense-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-expense');
    try {const item=expenseFromForm();b.disabled=true;await saveExpense(item);await refresh();resetExpenseForm();$('expense-form').hidden=true;notify('Разходът е запазен.');}
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('costs-filter').addEventListener('change',renderCosts);
  $('stats-period').addEventListener('change',renderStats);
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
  $('garage-form').addEventListener('submit',async event=>{
    event.preventDefault();const b=$('save-garage');
    try {const profile=garageFromForm();b.disabled=true;await saveGarage(profile);await refresh();loadGarageForm();notify('Garage е запазен.');}
    catch (error) {notify(error.message,true);}finally {b.disabled=false;}
  });
  $('export-backup').addEventListener('click',()=>downloadBackup().catch(e=>notify(e.message,true)));
  $('import-backup').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    $('selected-file').textContent=file.name;
    try {await importBackup(file);}catch(error){notify(error.message,true);}finally{event.target.value='';}
  });
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
