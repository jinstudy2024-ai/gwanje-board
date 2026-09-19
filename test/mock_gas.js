/**
 * Google Apps Script 모의(mock) 환경 — Code.gs 를 Node 에서 그대로 실행하기 위한 최소 구현.
 * SpreadsheetApp / LockService / Utilities / ContentService / HtmlService / ScriptApp / Logger 만 흉내낸다.
 * 실제 구글 서버와 동작이 다를 수 있는 부분: 시트 셀 타입 변환(여기선 그대로 저장), 동시성(무시).
 */
'use strict';
const crypto = require('crypto');

class Range {
  constructor(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.s.data[this.r - 1 + i] || [];
      const line = [];
      for (let j = 0; j < this.nc; j++) line.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]);
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(v) {
    for (let i = 0; i < v.length; i++) {
      while (this.s.data.length < this.r + i) this.s.data.push([]);
      const row = this.s.data[this.r - 1 + i];
      for (let j = 0; j < v[i].length; j++) row[this.c - 1 + j] = v[i][j];
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  setBackground() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.frozen = 0; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  appendRow(r) { this.data.push(r.slice()); return this; }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.data.length, 1), Math.max(this.getLastColumn(), 1)); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
  setFrozenRows(n) { this.frozen = n; return this; }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets[n] = s; return s; }
  getSheets() { return Object.values(this.sheets); }
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', hour).replace('mm', parts.minute).replace('ss', parts.second);
}

function install(target) {
  const ss = new Spreadsheet();
  const logs = [];
  target.SpreadsheetApp = { getActiveSpreadsheet: () => ss };
  target.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock() { return true; } }) };
  target.Utilities = { formatDate, getUuid: () => crypto.randomUUID() };
  target.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (s) => ({ _content: s, _mime: '', setMimeType(m) { this._mime = m; return this; }, getContent() { return this._content; } })
  };
  target.HtmlService = {
    createHtmlOutput: (s) => ({ _html: s, getContent() { return this._html; } }),
    createTemplateFromFile: (name) => ({
      _name: name,
      evaluate() { const t = this; return { _template: name, _token: t.token, setTitle() { return this; }, addMetaTag() { return this; } }; }
    })
  };
  target.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/EXAMPLE_DEPLOY_ID/exec' }) };
  target.Logger = { log: (m) => logs.push(String(m)) };
  return { ss, logs, formatDate };
}

module.exports = { install };
