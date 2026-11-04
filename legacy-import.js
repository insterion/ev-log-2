'use strict';
/* EV Log 2.0 v0.4 - import-only converters. No network, no writes, no Firebase. */
(function (root) {
  const LIMIT = 10000;
  const isDate = s => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
  };
  function number(value, label, {zero=true,max=1000000}={}) {
    if (value === null || value === undefined || String(value).trim()==='') throw Error(`Липсва ${label}.`);
    const n = Number(String(value).replace(/^[£\s]+/, '').trim());
    if (!Number.isFinite(n) || n < (zero?0:Number.EPSILON) || n > max) throw Error(`Невалидно число за ${label}: ${value}.`);
    return n;
  }
  const noteText = value => String(value ?? '').trim();
  const str = (value,limit) => noteText(value).slice(0,limit);
  function odo(raw) {
    if (raw===null || raw===undefined || String(raw).trim()==='') return null;
    const n=number(raw,'километраж',{max:9999999});
    if (!Number.isInteger(n)) throw Error('Километражът трябва да е цяло число.');
    return n;
  }
  function type(raw, warnings) {
    const t=noteText(raw).toLowerCase().replace(/[_\s]+/g,'-');
    if (['public','public-ac','ac','public-xp','publicxp'].includes(t)) return 'public';
    if (['fast','rapid','rapid-dc','dc','fast-dc','rapid-charging'].includes(t)) return 'rapid';
    if (['home','home-xp','homexp'].includes(t)) return 'home';
    if (['work','free','other','workplace'].includes(t)) return 'work';
    warnings.push(`Неизвестен тип „${raw}“ – провери го след импорта (временно: публично AC).`);
    return 'public';
  }
  function category(raw, warnings) {
    const c=noteText(raw).toLowerCase().replace(/[_-]+/g,' ');
    const map={insurance:'insurance', mot:'mot', tax:'tax','road tax':'tax',ved:'tax',service:'service',servicing:'service',tyres:'tyres',tires:'tyres',pads:'repair',brakes:'repair',repair:'repair',repairs:'repair',parking:'parking',cleaning:'cleaning',wash:'cleaning',other:'other'};
    if (Object.hasOwn(map,c)) return map[c];
    warnings.push(`Категория „${raw}“ е запазена като „Друго“.`);
    return 'other';
  }
  function target(raw, warnings, fallback='ev') {
    const t=noteText(raw).toLowerCase();
    if (['ev','electric','electric car'].includes(t)) return 'ev';
    if (['ice','fuel','petrol','diesel'].includes(t)) return 'ice';
    if (t==='both') return 'both';
    if (t==='other') return 'other';
    if (t==='') return fallback;
    warnings.push(`Неразпознат автомобил „${raw}“ – записан като „Неуточнен“.`);
    return 'other';
  }
  function normalizeCharge(entry, source, line) {
    const warnings=[];
    const date=noteText(entry.date);
    if (!isDate(date)) throw Error(`Невалидна дата: ${date}.`);
    const kwh=number(entry.kwh,'kWh',{zero:false,max:1000});
    const pricePerKwh=number(entry.price,'цена/kWh',{max:10});
    const originalTotal=entry.total===undefined?null:number(entry.total,'обща сума',{max:10000});
    if (originalTotal!==null && Math.abs(originalTotal-kwh*pricePerKwh)>0.03) warnings.push(`Сума в CSV £${originalTotal.toFixed(2)} се различава от kWh × цена (£${(kwh*pricePerKwh).toFixed(2)}).`);
    const note=str(entry.note,500);
    if (noteText(entry.note).length>500) warnings.push('Бележката е съкратена до 500 символа.');
    const result={id:'',date,kwh,pricePerKwh,type:type(entry.type,warnings),odometerMiles:odo(entry.odo),station:'',notes:note,createdAt:'',updatedAt:'',importSource:source};
    return {kind:'charge',record:result,warnings,source,line,originalId:entry.id?String(entry.id):''};
  }
  function normalizeCost(entry, source, line) {
    const warnings=[];
    const date=noteText(entry.date);
    if(!isDate(date)) throw Error(`Невалидна дата: ${date}.`);
    const amount=number(entry.amount,'сума',{max:1000000});
    const cat=category(entry.category,warnings);
    const car=target(entry.target,warnings,source==='old-json'?'other':'ev');
    const note=str(entry.note,500);
    let title=str(entry.title || entry.note || entry.category || 'Разход',120);
    if(!title) title='Разход';
    if(noteText(entry.note).length>500 || noteText(entry.title).length>120) warnings.push('Дългият текст е съкратен.');
    const record={id:'',date,amount,category:cat,target:car,title,notes:note,odometerMiles:null,createdAt:'',updatedAt:'',importSource:source};
    return {kind:'cost',record,warnings,source,line,originalId:entry.id?String(entry.id):''};
  }
  function csvRows(text) {
    const rows=[];let row=[],cell='',quoted=false;
    const s=String(text).replace(/^\uFEFF/,'');
    for (let i=0;i<s.length;i++) {
      const c=s[i];
      if (c==='"') {
        if (quoted && s[i+1]==='"') {cell+='"';i++;} else quoted=!quoted;
      } else if(c===',' && !quoted){row.push(cell);cell='';}
      else if((c==='\r' || c==='\n') && !quoted){
        if(c==='\r' && s[i+1]==='\n')i++;
        row.push(cell);cell='';
        if(row.some(x=>String(x).trim())) rows.push(row);
        row=[];
      } else {cell+=c;}
    }
    if(quoted)throw Error('CSV има незатворени кавички.');
    row.push(cell);if(row.some(x=>String(x).trim()))rows.push(row);
    return rows;
  }
  function parseCSV(text,filename='CSV файл') {
    const rows=csvRows(text);
    if(rows.length<2)throw Error(`${filename}: няма данни.`);
    const heads=rows[0].map(x=>x.trim().toLowerCase().replace(/^\uFEFF/,''));
    if(new Set(heads).size!==heads.length)throw Error(`${filename}: повторени имена на колони.`);
    const isLogs = ['date','kwh','type'].every(h=>heads.includes(h)) && (heads.includes('price') || heads.includes('price_per_kwh'));
    const isCosts = ['date','amount','category'].every(h=>heads.includes(h));
    if(!isLogs && !isCosts)throw Error(`${filename}: непознати CSV колони.`);
    const source = heads.includes('price_per_kwh') || heads.includes('appliesto') ? 'old-csv' : 'cloud-csv';
    const output=[], errors=[];
    if(rows.length-1 > LIMIT)throw Error(`Повече от ${LIMIT} реда. Раздели файла.`);
    for(let i=1;i<rows.length;i++) {
      const fields=rows[i];
      if(fields.length!==heads.length){errors.push(`Ред ${i+1}: ${fields.length} колони вместо ${heads.length}.`);continue;}
      const value=Object.fromEntries(heads.map((h,j)=>[h,fields[j]]));
      try {
        if(isLogs) output.push(normalizeCharge({date:value.date,odo:value.odometer??value.odo,type:value.type,kwh:value.kwh,price:value.price??value.price_per_kwh,total:value.total??value.cost,note:value.note},source,i+1));
        else output.push(normalizeCost({date:value.date,amount:value.amount,category:value.category,target:value.target??value.appliesto??value.applies,note:value.note},source,i+1));
      } catch(e) {errors.push(`Ред ${i+1}: ${e.message}`);}
    }
    return {items:output,errors,kind:isLogs?'зареждания':'разходи',filename};
  }
  function parseOldJson(text) {
    let data;
    try {data=JSON.parse(text);}catch(e){throw Error('Невалиден JSON. Постави целия текст от Export backup.');}
    if(!data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.costs) || !data.settings || typeof data.settings !== 'object') throw Error('Това не е архив от първото EV Log приложение.');
    if(data.entries.length+data.costs.length>LIMIT)throw Error('Прекалено много записи в архива.');
    const items=[],errors=[];
    data.entries.forEach((r,i)=>{try{items.push(normalizeCharge({date:r.date,kwh:r.kwh,type:r.type,price:r.price,note:r.note,id:r.id},'old-json',i+1));}catch(e){errors.push(`Зареждане ${i+1}: ${e.message}`);}});
    data.costs.forEach((r,i)=>{try{items.push(normalizeCost({date:r.date,amount:r.amount,category:r.category,target:r.applies,note:r.note,id:r.id},'old-json',i+1));}catch(e){errors.push(`Разход ${i+1}: ${e.message}`);}});
    return {items,errors,kind:'стар JSON',filename:'EV Log backup'};
  }
  root.EVLegacy = Object.freeze({parseCSV,parseOldJson});
  if(typeof module==='object' && module.exports)module.exports=root.EVLegacy;
})(typeof window==='object'?window:globalThis);
