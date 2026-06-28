import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const i18n = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8')

const testConnection = app.match(/async function testConnection[\s\S]*?async function refreshSessions/)
assert.ok(testConnection, 'testConnection function should be present')
assert.equal(testConnection[0].includes('setView("sessions")'), false, 'Test Connection must not navigate away from settings')
assert.equal(testConnection[0].includes('setConfig(configToTest)'), false, 'Test Connection must not save/apply draft settings')
assert.equal(testConnection[0].includes('localStorage.setItem(STORAGE_KEY'), false, 'Test Connection must not persist draft settings')

const saveConfig = app.match(/function saveConfig[\s\S]*?async function testConnection/)
assert.ok(saveConfig, 'saveConfig function should be present')
assert.equal(saveConfig[0].includes('setView("sessions")'), false, 'Save must leave success notice visible on settings page')
assert.equal(app.includes("t('settings.openSessions')"), false, 'Settings page must not show an unrelated Open Sessions action')
assert.ok(app.includes("t('settings.draftHint')"), 'Settings page should explain that edits are drafts until Save')
assert.equal(i18n.includes("'settings.openSessions'"), false, 'Open Sessions label should not be translated when the action is removed')
assert.ok(i18n.includes("'settings.testedNotSaved'"), 'Test success should explicitly say it did not save')
assert.ok(app.includes('function canTestConfig'), 'Settings should have a central testability check for required connection fields')
assert.ok(app.includes('disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}'), 'Test button should be disabled when fields are missing, testing is active, or the unchanged draft already passed')
assert.ok(app.includes('title={!canTestDraft ? t(\'settings.testNeedsFields\')'), 'Disabled Test button should explain missing required fields')
assert.ok(app.includes('testAlreadyPassedForDraft ? t(\'settings.testOk\')'), 'Passed unchanged test should be shown as Test OK')
assert.ok(app.includes('disabled={testingConnection || !hasDraftChanges}'), 'Save should be disabled when there are no draft changes')
assert.ok(app.includes('connection-help'), 'Settings should explain ready-to-test and unsaved/saved state')
assert.ok(i18n.includes("'settings.testNeedsFields'"), 'Settings must translate the disabled test reason')
assert.ok(i18n.includes("'settings.unsavedChanges'"), 'Settings must translate unsaved-change guidance')

console.log('settings regression tests passed')
