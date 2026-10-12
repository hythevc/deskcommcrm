/* Characterization of the saved explorer; DOM evidence, not browser proof. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => errors.push(error.message));
const fixture = process.argv[2] || path.join(__dirname, 'index.html');
const dom = new JSDOM(fs.readFileSync(fixture, 'utf8'), {
  runScripts: 'dangerously',
  virtualConsole,
  // External resources stay disabled; execute only this local, known artifact.
});
try {
  const document = dom.window.document;
  const summary = () => document.querySelector('#summary').textContent;
  const results = () => [...document.querySelectorAll('#files li')];
  assert.match(summary(), /^5552 matching files;/);
  assert.equal(results().length, 150);
  const search = document.querySelector('#search');
  search.value = 'proxy.ts';
  search.dispatchEvent(new dom.window.Event('input'));
  assert.ok(results().length > 0, 'Search must find the proxy');
  assert.ok(results().every((item) => item.textContent.toLowerCase().includes('proxy.ts')),
    'Search must exclude nonmatching files');
  document.querySelector('#reset').click();
  const group = document.querySelector('#group');
  group.value = '0';
  group.dispatchEvent(new dom.window.Event('change'));
  assert.match(summary(), /^886 matching files;/);
  document.querySelector('#reset').click();
  assert.match(summary(), /^5552 matching files;/);
  assert.equal(document.querySelectorAll('#viz circle').length, 12);
  assert.deepEqual(errors, [], 'Saved explorer scripts must execute without errors');
  process.stdout.write(JSON.stringify({ passed: true, checks: 8, evidence: 'DOM only' }) + '\n');
} finally {
  dom.window.close();
}
