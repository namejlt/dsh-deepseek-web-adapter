'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'driver.js'), 'utf8');
assert.ok(!/bodySnippet:\s*body\.slice/.test(source), 'login-state DOM probe must not return page text');
assert.ok(!/bodySnippet=.*slice/.test(source), 'login-state logs/errors must not emit page text');
assert.ok(!/\+\s*\(login\.bodySnippet/.test(source), 'provider errors must not include page snippets');
console.log('PASS driver login diagnostics do not expose page text');
