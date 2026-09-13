import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGINAL_HIDE_ID, validateOriginalRecords, assertVoiceRevision, assertOriginalRecordsRestored } from '../scripts/chatgpt-native-e2e.mjs';

const newChatID = '0215A2E4-50D5-4FB3-8645-E7692DB3B9C2', ownedID = 'owned-test';
const originals = () => ({ records: [
  { id: 'B670E42B-83D6-4C04-82FC-26B45043F03A', appKey: 'dev.extensionsanywhere.stylelab', isEnabled: true },
  { id: ORIGINAL_HIDE_ID, appKey: 'com.openai.codex', name: 'Hide Sidebar Voice Button', sourceType: 'css', isEnabled: true, sourceText: 'original CSS' },
  { id: newChatID, appKey: 'com.openai.codex', isEnabled: true, sourceText: 'original New Chat CSS' }
] });
function session(enabled = true) {
  const enabledIDs = [newChatID, ...(enabled ? [ownedID] : [])], voice = { matches: 1, display: enabled ? 'none' : 'flex' };
  return { status: { appKey: 'com.openai.codex', phase: 'active', revision: 1, enabledExtensionIDs: enabledIDs, signatureUnchanged: true, voice },
    report: { appKey: 'com.openai.codex', revisions: [{ enabledExtensionIDs: enabledIDs, stylesheetReadbackVerified: true, signatureUnchanged: true, appliedVoice: voice }] } };
}
const expectations = enabled => ({ enabledIDs: [newChatID, ...(enabled ? [ownedID] : [])], ownedID, ownedEnabled: enabled, display: enabled ? 'none' : 'flex' });

test('fixed snapshot requires the three unique originals and the enabled original Hide Voice record', () => {
  assert.deepEqual(validateOriginalRecords(originals()), [newChatID]);
  for (const alter of [
    value => value.records.pop(),
    value => value.records.push(value.records[1]),
    value => { value.records[1].isEnabled = false; },
    value => { value.records[1].appKey = 'another.app'; },
    value => { value.records[2].isEnabled = false; }
  ]) { const value = originals(); alter(value); assert.throws(() => validateOriginalRecords(value)); }
});

test('existing New Chat active CSS cannot count as the owned Voice proof', () => {
  assert.doesNotThrow(() => assertVoiceRevision(session(), expectations(true)));
  assert.doesNotThrow(() => assertVoiceRevision(session(false), expectations(false)));
  assert.throws(() => assertVoiceRevision(session(false), expectations(true)), /owned Voice revision/);
  for (const alter of [
    value => { value.status.enabledExtensionIDs = [ORIGINAL_HIDE_ID, newChatID]; },
    value => { value.report.revisions[0].stylesheetReadbackVerified = false; },
    value => { value.report.revisions.push({ ...value.report.revisions[0], enabledExtensionIDs: [newChatID] }); },
    value => { value.status.voice = { matches: 1, display: 'flex' }; }
  ]) { const value = session(); alter(value); assert.throws(() => assertVoiceRevision(value, expectations(true))); }
});

test('restoration verification requires every original record and order, without treating management logs as source edits', () => {
  const snapshot = originals();
  assert.doesNotThrow(() => assertOriginalRecordsRestored({ ...structuredClone(snapshot), logs: [{ event: 'Real management event' }] }, snapshot));
  for (const alter of [
    value => { value.records[1].isEnabled = false; },
    value => { value.records[2].sourceText = 'user edit'; },
    value => value.records.reverse(),
    value => value.records.push({ id: ownedID })
  ]) { const value = structuredClone(snapshot); alter(value); assert.throws(() => assertOriginalRecordsRestored(value, snapshot), /Original records/); }
});
