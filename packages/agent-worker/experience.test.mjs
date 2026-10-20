import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectExperience,experienceReviewInstructions} from './experience.mjs';
const item={lesson:'等待结束后先查原任务',applicability:'测试导出链路 v1',evidence:['report.md:12'],verification:'verified_this_task',invalidation:'任务协议改变时重新验证'};
const scope={scope:'group-a',topic:'export'};
const packet=items=>JSON.stringify({protocol:'codex_result_v1',result:'业务结果 https://example.test/download?signature=fixture',experienceCandidates:items});
test('bounded candidates remain pending, deduplicate and use scope-specific stable IDs',()=>{
 const a=collectExperience(packet([item,item]),scope);
 assert.equal(a.experienceReview.status,'pending');assert.equal(a.experienceReview.persisted,false);
 assert.equal(a.experienceReview.candidates.length,1);assert.equal(a.experienceReview.candidates[0].reviewStatus,'pending');
 assert.deepEqual(a,collectExperience(packet([item,item]),scope));
 assert.notEqual(a.experienceReview.candidates[0].id,collectExperience(packet([item]),{...scope,scope:'private'}).experienceReview.candidates[0].id);
 assert.equal(a.result,JSON.parse(packet([])).result);
});
test('no learning is valid; legacy and malformed output preserve completed results',()=>{
 assert.equal(collectExperience(packet([]),scope).experienceReview.status,'none');
 for(const raw of ['plain completed result','{invalid','null','{"result":"old"}']) {
  assert.equal(collectExperience(raw,scope).result,raw);assert.equal(collectExperience(raw,scope).experienceReview.status,'unavailable');
 }
});
test('rejects over-budget, fabricated state and incomplete candidates without failing business',()=>{
 for(const items of [[{...item,lesson:'x'.repeat(801)}],[{...item,evidence:[]}],[{...item,verification:'approved'}],[{...item,path:'../../MEMORY.md'}],Array(4).fill(item),[{...item,applicability:' '}],null]) {
  const r=collectExperience(packet(items),scope);assert.equal(r.experienceReview.status,'invalid');assert.deepEqual(r.experienceReview.candidates,[]);assert.equal(r.result,JSON.parse(packet([])).result);
 }
});

test('experience review uses native tools and requires shared scope and readback before saving',()=>{
 assert.match(experienceReviewInstructions,/native memory_search and memory_get/);
 assert.match(experienceReviewInstructions,/explicit workspace-sharing scope/);
 assert.match(experienceReviewInstructions,/write\/edit/);
 assert.match(experienceReviewInstructions,/read it back before claiming/);
 assert.ok(!experienceReviewInstructions.includes('ada_memory'));
});
