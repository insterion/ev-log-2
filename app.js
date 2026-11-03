'use strict';

// EV Log 2.0 v0.1 — no remote libraries, account or cloud storage.
const DB_NAME = 'evlog2-local';
const DB_VERSION = 1;
const STORE_CHARGES = 'charges';
const STORE_META = 'meta';
const BACKUP_FORMAT = 'ev-log-2';
const PRICE_HINTS = { public: 0.56, rapid: 0.79, home: 0.24, work: 0 };
const TYPE_NAMES = { public: 'Публично AC', rapid: 'Бързо DC', home: 'Домашно', work: 'Служебно / друго' };
const $ = id => document.getElementById(id);
const money = value => '£' + Number(value).toFixed(2);
const sumFor = entry => Math.round((entry.kwh * entry.pricePerKwh + Number.EPSILON) * 100) / 100;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const monthName = key => new Intl.DateTimeFormat('bg-BG', { month:'long', year:'numeric' }).format(new Date(`${key}-01T12:00:00`));
const fmtDate = iso => new Intl.DateTimeFormat('bg-BG', {day:'2-digit',month:'short',year:'numeric'}).format(new Date(`${iso}T12:00:00`));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `ev2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let db;
let records = [];
let editingId = null;
let toastTimeout;

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = error ? 'show error' : 'show';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { box.className = ''; }, 4200);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE_CHARGES)) {
        const store = database.createObjectStore(STORE_CHARGES, {keyPath:'id'});
        store.createIndex('date', 'date');
      }
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META, {keyPath:'key'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || Error('IndexedDB не се отвори.'));
    req.onblocked = () => reject(Error('Затвори другите отворени прозорци на EV Log 2.0 и опитай пак.'));
  });
}

function readAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHARGES, 'readonly');
    const req = tx.objectStore(STORE_CHARGES).getAll();
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(tx.error || Error('Не може да се прочете базата.'));
    tx.onabort = () => reject(tx.error || Error('Четенето е прекъснато.'));
  });
}

function writeRecord(record, remove = false) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHARGES, 'readwrite');
    const store = tx.objectStore(STORE_CHARGES);
    if (remove) store.delete(record.id);
    else store.put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || Error('Грешка при запис.'));
    tx.onabort = () => reject(tx.error || Error('Записът е прекъснат.'));
  });
}

async function refresh() {
  records = (await readAll()).sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderDashboard();
  renderHistory();
}

function navigate(view) {
  document.querySelectorAll('.view').forEach(section => {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-item').forEach(button => {
    const active = button.dataset.go === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  window.scrollTo(0,0);
}

function dateValid(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T12:00:00`);
  return !Number.isNaN(d.getTime()) && `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === iso;
}
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function validateEntry(raw) {
  if (!raw || typeof raw !== 'object') throw Error('Невалиден запис.');
  if (!dateValid(raw.date)) throw Error('Въведи валидна дата.');
  if (!Object.prototype.hasOwnProperty.call(TYPE_NAMES, raw.type)) throw Error('Невалиден тип зареждане.');
  if (!numeric(raw.kwh) || raw.kwh <= 0 || raw.kwh > 1000) throw Error('kWh трябва да са над 0 и не повече от 1000.');
  if (!numeric(raw.pricePerKwh) || raw.pricePerKwh < 0 || raw.pricePerKwh > 10) throw Error('Цената трябва да е от £0 до £10/kWh.');
  if (raw.odometerMiles !== null && (!numeric(raw.odometerMiles) || raw.odometerMiles < 0 || raw.odometerMiles > 9999999 || !Number.isInteger(raw.odometerMiles))) throw Error('Невалиден километраж в мили.');
  if (typeof raw.station !== 'string' || raw.station.length > 120 || typeof raw.notes !== 'string' || raw.notes.length > 500) throw Error('Бележките или станцията са твърде дълги.');
  if (typeof raw.id !== 'string' || raw.id.length < 3 || raw.id.length > 120) throw Error('Невалиден идентификатор на записа.');
  return raw;
}

function formRecord() {
  const kwhText = $('kwh').value.trim();
  const priceText = $('price').value.trim();
  if (kwhText === '' || priceText === '') throw Error('Попълни kWh и цена.');
  const odoText = $('odometer').value.trim();
  const previous = editingId ? records.find(x => x.id === editingId) : null;
  return validateEntry({
    id: previous ? previous.id : newId(),
    date: $('date').value,
    odometerMiles: odoText === '' ? null : Number(odoText),
    type: $('type').value,
    kwh: Number(kwhText),
    pricePerKwh: Number(priceText),
    station: $('station').value.trim(),
    notes: $('notes').value.trim(),
    createdAt: previous ? previous.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function updatePreview() {
  const kwh = Number($('kwh').value);
  const price = Number($('price').value);
  $('preview-total').textContent = Number.isFinite(kwh*price) && kwh > 0 && price >= 0 ? money(kwh*price) : '£0.00';
}
function defaultPrice() {
  const type = $('type').value;
  const lastMatch = records.find(r => r.type === type);
  $('price').value = String(lastMatch ? lastMatch.pricePerKwh : PRICE_HINTS[type]);
  updatePreview();
}
function resetForm() {
  editingId = null;
  $('charge-form').reset();
  $('date').value = today();
  $('type').value = 'public';
  defaultPrice();
  $('charge-title').textContent = 'Нов запис';
  $('form-subtitle').textContent = 'Попълни информацията от зарядната станция.';
  $('save-charge').textContent = 'Запази зареждането';
  $('cancel-edit').textContent = 'Изчисти формата';
}
function editRecord(id) {
  const item = records.find(record => record.id === id);
  if (!item) return toast('Записът не е намерен.',true);
  editingId = item.id;
  $('date').value = item.date;
  $('odometer').value = item.odometerMiles ?? '';
  $('type').value = item.type;
  $('kwh').value = item.kwh;
  $('price').value = item.pricePerKwh;
  $('station').value = item.station;
  $('notes').value = item.notes;
  $('charge-title').textContent = 'Редактиране';
  $('form-subtitle').textContent = 'Промени полетата и запази.';
  $('save-charge').textContent = 'Запази промените';
  $('cancel-edit').textContent = 'Откажи редакцията';
  updatePreview();
  navigate('charge');
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}
function recordCard(record, actions = false) {
  const card = element('article','record');
  const top = element('div','record-top');
  const heading = element('div');
  heading.append(element('div','record-title',record.station || TYPE_NAMES[record.type]),element('div','record-date',fmtDate(record.date)));
  top.append(heading,element('div','record-value',money(sumFor(record))));
  card.append(top);
  const chips = element('div','record-meta');
  [ `${record.kwh} kWh`, money(record.pricePerKwh)+'/kWh', TYPE_NAMES[record.type], ...(record.odometerMiles === null ? [] : [record.odometerMiles.toLocaleString('en-GB')+' mi']) ].forEach(value => chips.append(element('span','',value)));
  card.append(chips);
  if (record.notes) card.append(element('p','record-note',record.notes));
  if (actions) {
    const buttons = element('div','record-actions');
    const edit = element('button','', 'Редактирай');
    edit.type = 'button'; edit.dataset.action = 'edit'; edit.dataset.id = record.id;
    const remove = element('button','danger','Изтрий');
    remove.type = 'button'; remove.dataset.action = 'delete'; remove.dataset.id = record.id;
    buttons.append(edit,remove); card.append(buttons);
  }
  return card;
}
function renderList(container, items, actions = false) {
  container.replaceChildren();
  if (!items.length) {
    container.append(element('p','empty','Няма записи за избрания период.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach(item => fragment.append(recordCard(item, actions)));
  container.append(fragment);
}
function renderDashboard() {
  const current = today().slice(0,7);
  const month = records.filter(item => item.date.slice(0,7) === current);
  const total = month.reduce((s,item) => s + sumFor(item),0);
  const kwh = month.reduce((s,item) => s + item.kwh,0);
  $('month-label').textContent = monthName(current);
  $('month-cost').textContent = money(total);
  $('month-kwh').textContent = kwh ? `${Number(kwh.toFixed(2))} kWh` : '0 kWh';
  $('month-price').textContent = kwh ? `${money(total/kwh)}/kWh` : '—';
  $('month-count').textContent = String(month.length);
  renderList($('recent-list'), records.slice(0,3));
}
function renderHistory() {
  const select = $('history-filter');
  const prior = select.value;
  const months = [...new Set(records.map(item => item.date.slice(0,7)))].sort().reverse();
  select.replaceChildren(new Option('Всички месеци','all'));
  months.forEach(month => select.add(new Option(monthName(month),month)));
  select.value = months.includes(prior) ? prior : 'all';
  renderHistoryItems();
}
function renderHistoryItems() {
  const selected = $('history-filter').value;
  const filtered = selected === 'all' ? records : records.filter(item => item.date.startsWith(selected));
  $('history-summary').textContent = `${filtered.length} записа`;
  $('history-sum').textContent = money(filtered.reduce((s,item) => s + sumFor(item),0));
  renderList($('history-list'), filtered, true);
}

function fingerprint(entry) {
  return [entry.date,entry.odometerMiles ?? '',entry.type,entry.kwh,entry.pricePerKwh,entry.station.trim().toLocaleLowerCase(),entry.notes.trim().toLocaleLowerCase()].join('\u001f');
}
function validateBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT || data.version !== 1 || !Array.isArray(data.charges)) {
    throw Error('Този файл не е архив от EV Log 2.0 v0.1. Старите архиви ще се поддържат в следваща версия.');
  }
  if (data.charges.length > 100000) throw Error('Архивът съдържа прекалено много записи.');
  const ids = new Set();
  for (const entry of data.charges) {
    validateEntry(entry);
    if (ids.has(entry.id)) throw Error('В архива има повтарящи се идентификатори.');
    ids.add(entry.id);
  }
  return data.charges;
}
function downloadBackup() {
  const payload = { format:BACKUP_FORMAT,version:1,exportedAt:new Date().toISOString(),charges:records.map(item => ({...item})) };
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `EV-Log-2-backup-${today()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),60000);
  toast(`Архивът е подготвен (${records.length} записа). Провери папка Downloads.`);
}
async function importBackup(file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) throw Error('Файлът е прекалено голям (макс. 30 MB).');
  const content = await file.text();
  let data;
  try { data = JSON.parse(content); } catch (_) { throw Error('Файлът не е валиден JSON.'); }
  const source = validateBackup(data);
  await refresh();
  const seenIds = new Set(records.map(item => item.id));
  const seenFingerprints = new Set(records.map(fingerprint));
  const toAdd = [];
  for (const item of source) {
    const signature = fingerprint(item);
    if (!seenIds.has(item.id) && !seenFingerprints.has(signature)) {
      toAdd.push(item);
      seenIds.add(item.id);
      seenFingerprints.add(signature);
    }
  }
  if (!toAdd.length) { toast(`Няма нови записи. Пропуснати: ${source.length}.`); return; }
  if (!confirm(`Архивът съдържа ${source.length} записа. Ще добавя ${toAdd.length} нови и ще пропусна ${source.length-toAdd.length} повторения. Продължаваме ли?`)) return;
  await new Promise((resolve,reject) => {
    const tx = db.transaction(STORE_CHARGES,'readwrite');
    const store = tx.objectStore(STORE_CHARGES);
    toAdd.forEach(item => store.add(item));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || Error('Неуспешен импорт.'));
    tx.onabort = () => reject(tx.error || Error('Импортът е прекъснат.'));
  });
  await refresh();
  toast(`Добавени ${toAdd.length} записа. Пропуснати ${source.length-toAdd.length}.`);
}

function attachEvents() {
  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
  $('quick-add').addEventListener('click', () => { resetForm(); navigate('charge'); });
  $('type').addEventListener('change',defaultPrice);
  $('kwh').addEventListener('input',updatePreview);
  $('price').addEventListener('input',updatePreview);
  $('charge-form').addEventListener('submit',async event => {
    event.preventDefault();
    const saveButton = $('save-charge');
    try {
      const entry = formRecord();
      saveButton.disabled = true;
      await writeRecord(entry);
      await refresh();
      resetForm();
      navigate('home');
      toast('Зареждането е запазено.');
    } catch (error) { toast(error.message,true); }
    finally { saveButton.disabled = false; }
  });
  $('same-as-last').addEventListener('click',() => {
    if (!records.length) return toast('Все още няма предишно зареждане.',true);
    const last = records[0];
    resetForm();
    $('type').value = last.type;
    $('kwh').value = last.kwh;
    $('price').value = last.pricePerKwh;
    $('station').value = last.station;
    $('notes').value = last.notes;
    // Do not repeat previous date or odometer.
    updatePreview();
    toast('Полетата са попълнени. Провери ги преди запис.');
  });
  $('cancel-edit').addEventListener('click',resetForm);
  $('history-filter').addEventListener('change',renderHistoryItems);
  $('history-list').addEventListener('click',async event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === 'edit') return editRecord(id);
    const item = records.find(record => record.id === id);
    if (!item) return;
    if (!confirm(`Да изтрия зареждането от ${fmtDate(item.date)} (${money(sumFor(item))})?`)) return;
    try { button.disabled = true; await writeRecord(item,true); await refresh(); toast('Записът е изтрит.'); }
    catch (error) { button.disabled = false; toast(error.message,true); }
  });
  $('export-backup').addEventListener('click',downloadBackup);
  $('import-backup').addEventListener('change',async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('selected-file').textContent = file.name;
    try { await importBackup(file); }
    catch (error) { toast(error.message,true); }
    finally { event.target.value = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh().catch(error => toast(error.message,true));
  });
}

async function start() {
  try {
    if (!('indexedDB' in window)) throw Error('Този браузър не поддържа IndexedDB.');
    db = await openDb();
    db.onversionchange = () => { db.close(); toast('Има нова версия. Презареди приложението.',true); };
    await refresh();
    resetForm();
    attachEvents();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service Worker:',error));
    }
  } catch (error) {
    console.error(error);
    toast(`Базата не е достъпна: ${error.message}`,true);
    $('main').insertAdjacentElement('afterbegin',element('p','empty','Не може да се отвори локалната база. Провери дали Chrome е в нормален режим и дали има свободно място. Не въвеждай данни, докато проблемът не е решен.'));
  }
}
start();
