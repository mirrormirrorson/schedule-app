const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('all browser scripts parse as JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scriptPaths = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.startsWith('/js/'));
  assert.deepEqual(scriptPaths, [
    '/js/state-sync.js',
    '/js/schedule-core.js',
    '/js/management.js',
    '/js/view-export.js',
    '/js/identity-history.js',
    '/js/bootstrap.js',
    '/js/background.js',
  ]);
  scriptPaths.forEach(scriptPath => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', scriptPath), 'utf8');
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: scriptPath }),
      `${scriptPath} should parse`,
    );
  });
});

test('frontend entrypoint references extracted stylesheet and contains no large inline code blocks', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/enhancements\.css">/);
  assert.doesNotMatch(html, /<style>/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]{200,}<\/script>/i);
});
