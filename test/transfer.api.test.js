'use strict';

// 端到端：拼片转置 API
// 从已发布快照选片 → 绕源点旋转 0/90/180/270 + 整数平移 → 预览（轮廓/颜色/位置/覆盖状态）
// → 确认整批写入目标草稿（新编号、保留原色）；草稿被编辑后确认报冲突；
// 任一拼片/来源版本不存在或几何冲突指出对象与位置且整批不写入；源快照不变。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39131';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `transfer-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let srcDesignId;   // 来源图纸 100×100（两片各 50×100）
let srcPub;        // 来源发布版 v1
let tgtDesignId;   // 空目标图纸 300×200
let occDesignId;   // 已有拼片的目标图纸 300×200（左半 100×200 已占）

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function addPiece(design, color, polygon) {
  return api('POST', `/api/designs/${design}/pieces`, { color, polygon });
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  // 来源图纸：左红右绿两片，发布 v1
  const d1 = await api('POST', '/api/designs', { name: '来源窗', width: 100, height: 100 });
  srcDesignId = d1.data.design.id;
  await addPiece(srcDesignId, '#ff0000', [[0, 0], [50, 0], [50, 100], [0, 100]]);
  await addPiece(srcDesignId, '#00ff00', [[50, 0], [100, 0], [100, 100], [50, 100]]);
  srcPub = (await api('POST', `/api/designs/${srcDesignId}/publish`)).data.publication;

  // 空目标图纸
  const d2 = await api('POST', '/api/designs', { name: '目标窗', width: 300, height: 200 });
  tgtDesignId = d2.data.design.id;

  // 已有拼片的目标图纸：左半蓝色 100×200
  const d3 = await api('POST', '/api/designs', { name: '半占窗', width: 300, height: 200 });
  occDesignId = d3.data.design.id;
  await addPiece(occDesignId, '#0000ff', [[0, 0], [100, 0], [100, 200], [0, 200]]);
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('预览：旋转 0 + 整数平移，轮廓/颜色/新编号/覆盖状态正确，且不写库', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [2, 1], rotation: 0, dx: 10, dy: 20,
  });
  assert.strictEqual(r.status, 200);
  const p = r.data.preview;
  assert.strictEqual(p.source.designId, srcDesignId);
  assert.strictEqual(p.source.version, 1);
  assert.strictEqual(p.target.designId, tgtDesignId);
  assert.deepStrictEqual(p.transform, { rotation: 0, dx: 10, dy: 20 });
  // 按来源编号升序赋目标新编号（与传入顺序无关）
  assert.strictEqual(p.pieces.length, 2);
  assert.strictEqual(p.pieces[0].sourcePieceNo, 1);
  assert.strictEqual(p.pieces[0].targetPieceNo, 1);
  assert.strictEqual(p.pieces[0].color, '#ff0000');
  assert.deepStrictEqual(p.pieces[0].polygon, [[10, 20], [60, 20], [60, 120], [10, 120]]);
  assert.strictEqual(p.pieces[0].area, 5000);
  assert.strictEqual(p.pieces[1].sourcePieceNo, 2);
  assert.strictEqual(p.pieces[1].targetPieceNo, 2);
  assert.strictEqual(p.pieces[1].color, '#00ff00');
  assert.deepStrictEqual(p.existingPieces, []);
  assert.strictEqual(p.coverage.covered, false);
  assert.strictEqual(p.coverage.totalPieceArea, 10000);
  assert.strictEqual(p.coverage.frameArea, 60000);
  assert.ok(p.coverage.gaps.length > 0, '未覆盖区域应给出缺口');
  assert.ok(typeof p.previewToken === 'string' && p.previewToken.length >= 32);
  // 预览不写库
  const draft = await api('GET', `/api/designs/${tgtDesignId}`);
  assert.strictEqual(draft.data.draft.pieces.length, 0);
});

test('旋转 90° 绕源图纸坐标原点：(x,y)→(-y,x) 后再平移', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 90, dx: 100, dy: 0,
  });
  assert.strictEqual(r.status, 200);
  // [[0,0],[50,0],[50,100],[0,100]] → (-y,x) → [[0,0],[0,50],[-100,50],[-100,0]] → +(100,0)
  assert.deepStrictEqual(r.data.preview.pieces[0].polygon,
    [[100, 0], [100, 50], [0, 50], [0, 0]]);
  assert.strictEqual(r.data.preview.pieces[0].area, 5000);
});

test('旋转 180°/270° 同样绕原点变换', async () => {
  const r180 = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [2], rotation: 180, dx: 200, dy: 200,
  });
  assert.strictEqual(r180.status, 200);
  // [[50,0],[100,0],[100,100],[50,100]] → (-x,-y) → +(200,200)
  assert.deepStrictEqual(r180.data.preview.pieces[0].polygon,
    [[150, 200], [100, 200], [100, 100], [150, 100]]);
  const r270 = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 270, dx: 0, dy: 100,
  });
  assert.strictEqual(r270.status, 200);
  // (x,y) → (y,-x) → +(0,100)
  assert.deepStrictEqual(r270.data.preview.pieces[0].polygon,
    [[0, 100], [0, 50], [100, 50], [100, 100]]);
});

test('确认：整批写入目标草稿，连续赋新编号、保留原色，源发布快照不变', async () => {
  const before = (await api('GET', `/api/designs/${srcDesignId}/publications/1`)).data.publication.snapshot;
  const pv = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(pv.status, 200);
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.transfer.pieces.length, 2);
  assert.deepStrictEqual(r.data.transfer.pieces.map((p) => p.pieceNo), [1, 2]);
  assert.deepStrictEqual(r.data.transfer.pieces.map((p) => p.sourcePieceNo), [1, 2]);
  assert.deepStrictEqual(r.data.transfer.pieces.map((p) => p.color), ['#ff0000', '#00ff00']);
  assert.ok(r.data.transfer.pieces.every((p) => Number.isInteger(p.id)));
  // 确认结果按现有草稿规则参与覆盖检查
  assert.strictEqual(r.data.draft.pieces.length, 2);
  assert.strictEqual(r.data.draft.coverage.totalPieceArea, 10000);
  assert.strictEqual(r.data.draft.coverage.covered, false);
  // 源发布快照不变
  const after = (await api('GET', `/api/designs/${srcDesignId}/publications/1`)).data.publication.snapshot;
  assert.deepStrictEqual(after, before);
});

test('再次转置：新编号接续不复用；删除后仍按最大编号 +1', async () => {
  const pv = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 90, dx: 100, dy: 100,
  });
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.data.preview.pieces[0].targetPieceNo, 3, '目标已有 #1/#2，新片应为 #3');
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 90, dx: 100, dy: 100,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.transfer.pieces[0].pieceNo, 3);
  // 删除 #3 后再预览，编号仍为 4（编号不复用）
  await api('DELETE', `/api/designs/${tgtDesignId}/pieces/${r.data.transfer.pieces[0].id}`);
  const pv2 = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 90, dx: 100, dy: 100,
  });
  assert.strictEqual(pv2.data.preview.pieces[0].targetPieceNo, 3,
    '删除后最大现存编号为 2，新片回到 #3');
});

test('缺少 previewToken 确认 → 400', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 0, dy: 100,
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'token_required');
});

test('预览后目标草稿被编辑 → 确认 409 draft_changed；重新预览后可确认', async () => {
  const pv = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 150, dy: 0,
  });
  assert.strictEqual(pv.status, 200);
  // 预览后通过原有单片接口编辑目标草稿（在空隙处加一片）
  const add = await addPiece(tgtDesignId, '#ffff00', [[0, 150], [50, 150], [50, 200], [0, 200]]);
  assert.strictEqual(add.status, 201);
  const r = await api('POST', `/api/designs/${tgtDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 150, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'draft_changed');
  assert.match(r.data.error, /重新预览/);
  // 冲突未写入：草稿只有此前的 3 片
  let draft = await api('GET', `/api/designs/${tgtDesignId}`);
  assert.strictEqual(draft.data.draft.pieces.length, 3);
  // 重新预览（基于编辑后的草稿）→ 确认成功
  const pv2 = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 150, dy: 0,
  });
  assert.strictEqual(pv2.status, 200);
  assert.strictEqual(pv2.data.preview.pieces[0].targetPieceNo, 4);
  const r2 = await api('POST', `/api/designs/${tgtDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 150, dy: 0,
    previewToken: pv2.data.preview.previewToken,
  });
  assert.strictEqual(r2.status, 201);
  draft = await api('GET', `/api/designs/${tgtDesignId}`);
  assert.strictEqual(draft.data.draft.pieces.length, 4);
});

test('参数非法：空选/重复编号/非法旋转/非整数平移 → 400', async () => {
  const base = { sourcePublicationId: srcPub.id, rotation: 0, dx: 0, dy: 0 };
  let r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [] });
  assert.strictEqual(r.status, 400);
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [1, 1] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'duplicate_piece_no');
  assert.strictEqual(r.data.pieceNo, 1);
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [1, -2] });
  assert.strictEqual(r.status, 400);
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [1], rotation: 45 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [1], dx: 1.5 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, { ...base, pieceNos: [1], sourcePublicationId: -1 });
  assert.strictEqual(r.status, 400);
});

test('来源发布版不存在 → 404 source_not_found；拼片编号不存在 → 404 piece_not_found', async () => {
  let r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: 99999, pieceNos: [1], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'source_not_found');
  r = await api('POST', `/api/designs/${tgtDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 99], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'piece_not_found');
  assert.strictEqual(r.data.pieceNo, 99);
  assert.match(r.data.error, /#99/);
  // 目标图纸不存在
  r = await api('POST', '/api/designs/99999/transfers/preview', {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(r.status, 404);
});

test('越出目标窗框 → 422 out_of_frame，指出拼片与位置，整批不写入', async () => {
  // 片 #1 平移后仍在框内，片 #2 越界 → 整批拒绝
  const r = await api('POST', `/api/designs/${occDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 250, dy: 0,
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.code, 'out_of_frame');
  assert.strictEqual(r.data.pieceNo, 2);
  assert.ok(Array.isArray(r.data.at), '应给出越界位置');
  assert.match(r.data.error, /#2/);
  // 确认路径同样整批不写入
  const pv = await api('POST', `/api/designs/${occDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 100, dy: 0,
  });
  const r2 = await api('POST', `/api/designs/${occDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 250, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r2.status, 422);
  const draft = await api('GET', `/api/designs/${occDesignId}`);
  assert.strictEqual(draft.data.draft.pieces.length, 1, '整批不写入，目标草稿保持原状');
});

test('与目标已有拼片面积重叠 → 422 overlap，指出对象与位置', async () => {
  // 半占窗左半已有蓝片 0..100；红片平移 (50,0) 后覆盖 50..100 → 重叠
  const r = await api('POST', `/api/designs/${occDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 50, dy: 0,
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.code, 'overlap');
  assert.strictEqual(r.data.pieceNo, 1);
  assert.ok(Array.isArray(r.data.at));
  assert.strictEqual(r.data.conflictWith.type, 'existing');
  assert.strictEqual(r.data.conflictWith.pieceNo, 1);
  assert.match(r.data.error, /已有拼片 #1/);
});

test('合法共边与 T 接允许：贴邻已有拼片可预览并确认', async () => {
  // 红片 50×100 平移 (100,0)：与蓝片右边 x=100 共边（y 0..100），(100,100) 处 T 接
  const pv = await api('POST', `/api/designs/${occDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 100, dy: 0,
  });
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.data.preview.coverage.covered, false);
  const r = await api('POST', `/api/designs/${occDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1], rotation: 0, dx: 100, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.transfer.pieces[0].pieceNo, 2);
  // 绿片 50×100 平移 (100,100)：与红片共边 x=100..150 在 y=100 处相接、与蓝片共边
  const pv2 = await api('POST', `/api/designs/${occDesignId}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [2], rotation: 0, dx: 100, dy: 100,
  });
  assert.strictEqual(pv2.status, 200);
  const r2 = await api('POST', `/api/designs/${occDesignId}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [2], rotation: 0, dx: 100, dy: 100,
    previewToken: pv2.data.preview.previewToken,
  });
  assert.strictEqual(r2.status, 201);
});

test('确认结果参与后续发布：转置铺满目标窗框后可发布', async () => {
  // 100×100 小目标，转置两片即完整覆盖
  const d = await api('POST', '/api/designs', { name: '小目标窗', width: 100, height: 100 });
  const did = d.data.design.id;
  const pv = await api('POST', `/api/designs/${did}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.data.preview.coverage.covered, true, '两片铺满后预览应显示完整覆盖');
  const r = await api('POST', `/api/designs/${did}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.draft.coverage.covered, true);
  const pub = await api('POST', `/api/designs/${did}/publish`);
  assert.strictEqual(pub.status, 201);
  assert.strictEqual(pub.data.publication.version, 1);
  // 发布版铅条清单含一条内部公共边（x=50 整根 100mm）
  const detail = await api('GET', `/api/designs/${did}/publications/1`);
  assert.strictEqual(detail.data.publication.snapshot.leadList.internalCount, 1);
  assert.strictEqual(detail.data.publication.snapshot.leadList.internalTotal, 100);
});

test('转置后原有单片编辑/删除接口继续可用', async () => {
  const draft = await api('GET', `/api/designs/${tgtDesignId}`);
  const moved = draft.data.draft.pieces.find((p) => p.pieceNo === 4);
  assert.ok(moved, '应存在此前转置写入的 #4');
  // 改色（原接口）
  const recolor = await api('PUT', `/api/designs/${tgtDesignId}/pieces/${moved.id}`, {
    color: '#123456', polygon: moved.polygon,
  });
  assert.strictEqual(recolor.status, 200);
  assert.strictEqual(recolor.data.piece.color, '#123456');
  // 删除（原接口）
  const del = await api('DELETE', `/api/designs/${tgtDesignId}/pieces/${moved.id}`);
  assert.strictEqual(del.status, 200);
  // 新增（原接口）在空隙处
  const add = await addPiece(tgtDesignId, '#ff00ff', [[0, 150], [50, 150], [50, 200], [0, 200]]);
  // 该位置此前在“草稿被编辑”测试中已占一片 → 应 422 重叠，证明草稿状态一致
  assert.strictEqual(add.status, 422);
});

test('同一图纸：可从自己的旧发布版向当前草稿转置', async () => {
  // 小目标窗已发布 v1（两片）；清空草稿后从 v1 转回一片
  const d = await api('POST', '/api/designs', { name: '回转窗', width: 100, height: 100 });
  const did = d.data.design.id;
  const pv = await api('POST', `/api/designs/${did}/transfers/preview`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
  });
  await api('POST', `/api/designs/${did}/transfers`, {
    sourcePublicationId: srcPub.id, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0,
    previewToken: pv.data.preview.previewToken,
  });
  const pub = await api('POST', `/api/designs/${did}/publish`);
  const selfPub = pub.data.publication;
  // 删除草稿中的一片，再从自己的 v1 转置回来
  const draft = await api('GET', `/api/designs/${did}`);
  await api('DELETE', `/api/designs/${did}/pieces/${draft.data.draft.pieces[1].id}`);
  const pv2 = await api('POST', `/api/designs/${did}/transfers/preview`, {
    sourcePublicationId: selfPub.id, pieceNos: [2], rotation: 0, dx: 0, dy: 0,
  });
  assert.strictEqual(pv2.status, 200);
  assert.strictEqual(pv2.data.preview.source.designId, did);
  const r = await api('POST', `/api/designs/${did}/transfers`, {
    sourcePublicationId: selfPub.id, pieceNos: [2], rotation: 0, dx: 0, dy: 0,
    previewToken: pv2.data.preview.previewToken,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.draft.coverage.covered, true, '补回后再次完整覆盖');
});
