'use strict';

// 拼片转置：从一份已发布图纸（不可变快照）选取若干拼片编号，
// 绕源图纸坐标原点旋转 0/90/180/270° 并做整数毫米平移后，整批写入目标图纸草稿。
// 旋转/平移都是整数刚性变换，坐标保持整数毫米；几何判定复用精确整数运算。

const geo = require('./geometry');

const ROTATIONS = new Set([0, 90, 180, 270]);
const MAX_TRANSLATE = 1000000; // 平移量上限（毫米，窗框最大 100000，留足余量）
const MAX_PIECES = 1000;       // 单批最多转置片数

// 解析并校验转置参数。
// 返回 { ok:true, params:{sourcePublicationId,pieceNos,rotation,dx,dy} }
//   或 { ok:false, status, code, error, pieceNo? }
function parseParams(body) {
  const b = body || {};
  const sourcePublicationId = Number(b.sourcePublicationId);
  if (!Number.isInteger(sourcePublicationId) || sourcePublicationId <= 0) {
    return { ok: false, status: 400, code: 'invalid', error: 'sourcePublicationId 必须是来源发布版的正整数 id' };
  }
  const nos = b.pieceNos;
  if (!Array.isArray(nos) || nos.length === 0) {
    return { ok: false, status: 400, code: 'invalid', error: 'pieceNos 必须是非空数组：至少选取一片拼片编号' };
  }
  if (nos.length > MAX_PIECES) {
    return { ok: false, status: 400, code: 'invalid', error: `单批最多转置 ${MAX_PIECES} 片` };
  }
  const seen = new Set();
  const pieceNos = [];
  for (const n of nos) {
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, status: 400, code: 'invalid', error: 'pieceNos 每项必须是正整数拼片编号' };
    }
    if (seen.has(n)) {
      return { ok: false, status: 400, code: 'duplicate_piece_no', error: `拼片编号 #${n} 重复选择，每片只能选一次`, pieceNo: n };
    }
    seen.add(n);
    pieceNos.push(n);
  }
  const rotation = Number(b.rotation);
  if (!ROTATIONS.has(rotation)) {
    return { ok: false, status: 400, code: 'invalid', error: 'rotation 必须是 0/90/180/270 之一（绕源图纸坐标原点逆时针旋转）' };
  }
  const dx = Number(b.dx);
  const dy = Number(b.dy);
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
    return { ok: false, status: 400, code: 'invalid', error: 'dx/dy 必须是整数毫米平移量' };
  }
  if (Math.abs(dx) > MAX_TRANSLATE || Math.abs(dy) > MAX_TRANSLATE) {
    return { ok: false, status: 400, code: 'invalid', error: `dx/dy 超出允许范围（±${MAX_TRANSLATE} 毫米）` };
  }
  return { ok: true, params: { sourcePublicationId, pieceNos, rotation, dx, dy } };
}

// 绕源图纸坐标原点旋转（y 轴向上，逆时针为正）后平移；整数坐标旋转变换后仍为整数
function transformPoint(x, y, rotation, dx, dy) {
  let rx;
  let ry;
  switch (rotation) {
    case 90: rx = -y; ry = x; break;
    case 180: rx = -x; ry = -y; break;
    case 270: rx = y; ry = -x; break;
    default: rx = x; ry = y; // 0°
  }
  return [rx + dx, ry + dy];
}

function transformPolygon(polygon, rotation, dx, dy) {
  return polygon.map(([x, y]) => transformPoint(x, y, rotation, dx, dy));
}

// 由来源快照与目标草稿构建转置方案（预览与确认共用同一套校验，保证结果一致）。
// sourcePub: 发布版对象（含不可变 snapshot）；targetDesign: 目标图纸行；
// targetPieces: 目标草稿现有拼片（db.listPieces 输出）。
// 返回 { ok:true, pieces:[{sourcePieceNo,color,polygon,area}], coverage }
//   或 { ok:false, status, code, error, category?, pieceNo?, at?, conflictWith? }
function buildBatch(sourcePub, targetDesign, targetPieces, params) {
  const byNo = new Map(sourcePub.snapshot.pieces.map((p) => [p.pieceNo, p]));
  // 确定性顺序：按来源拼片编号升序校验并赋予目标新编号
  const ordered = params.pieceNos.slice().sort((a, b) => a - b);
  const selected = [];
  for (const no of ordered) {
    const src = byNo.get(no);
    if (!src) {
      return {
        ok: false, status: 404, code: 'piece_not_found',
        error: `来源发布版「${sourcePub.snapshot.name}」v${sourcePub.version} 中不存在拼片编号 #${no}`,
        pieceNo: no,
      };
    }
    selected.push(src);
  }

  const frame = { width: targetDesign.width_mm, height: targetDesign.height_mm };
  const existing = targetPieces.map((p) => ({ id: p.id, polygon: p.polygon }));
  const accepted = []; // 本批已校验通过的片（id 记来源编号，用于批内互相校验）
  const out = [];

  for (const src of selected) {
    const polygon = transformPolygon(src.polygon, params.rotation, params.dx, params.dy);

    // 1) 转置后仍必须是合法多边形（刚性变换不会改变合法性，此处为防御性复核）
    const self = geo.validatePolygon(polygon);
    if (!self.ok) {
      return {
        ok: false, status: 422, code: 'invalid', category: 'invalid',
        error: `拼片 #${src.pieceNo} 转置后不是合法多边形：${self.reason}`,
        pieceNo: src.pieceNo, at: self.at || null,
      };
    }

    // 2) 完全落在目标窗框内 + 与目标已有拼片不得面积重叠（共边/T 接合法）
    const relExisting = geo.checkAgainstPieces(polygon, existing, frame);
    if (!relExisting.ok) {
      const other = relExisting.pieceId != null
        ? targetPieces.find((p) => p.id === relExisting.pieceId) : null;
      const outOfFrame = relExisting.reason.includes('越出窗框');
      return {
        ok: false, status: 422,
        code: outOfFrame ? 'out_of_frame' : 'overlap',
        category: outOfFrame ? 'out_of_frame' : 'overlap',
        error: outOfFrame
          ? `拼片 #${src.pieceNo} 转置后越出目标窗框（${relExisting.reason}）`
          : `拼片 #${src.pieceNo} 转置后与目标图纸已有拼片 #${other ? other.pieceNo : '?'} 面积重叠（${relExisting.reason}）`,
        pieceNo: src.pieceNo,
        at: relExisting.at ? relExisting.at.slice() : null,
        conflictWith: other ? { type: 'existing', id: other.id, pieceNo: other.pieceNo } : null,
      };
    }

    // 3) 与本批前面已接受的片不得面积重叠
    //    （同一快照的片经同一刚性变换不会互相重叠，此处为防御性复核）
    const relBatch = geo.checkAgainstPieces(polygon, accepted, null);
    if (!relBatch.ok) {
      return {
        ok: false, status: 422, code: 'overlap', category: 'overlap',
        error: `拼片 #${src.pieceNo} 转置后与本次转置的拼片 #${relBatch.pieceId} 面积重叠（${relBatch.reason}）`,
        pieceNo: src.pieceNo,
        at: relBatch.at ? relBatch.at.slice() : null,
        conflictWith: { type: 'batch', pieceNo: relBatch.pieceId },
      };
    }

    accepted.push({ id: src.pieceNo, polygon });
    out.push({
      sourcePieceNo: src.pieceNo,
      color: src.color, // 保留原色
      polygon,
      area: geo.round2(geo.polygonArea(polygon)),
    });
  }

  // 4) 草稿覆盖状态：目标现有片 + 本批片一起按现有草稿规则分析
  const analysis = geo.analyzePlan(frame, [
    ...existing,
    ...accepted.map((p, i) => ({ id: -(i + 1), polygon: p.polygon })),
  ]);

  return {
    ok: true,
    pieces: out,
    coverage: {
      covered: analysis.covered,
      gaps: analysis.gaps,
      overlapping: analysis.overlapping,
      totalPieceArea: analysis.totalPieceArea,
      frameArea: frame.width * frame.height,
    },
  };
}

module.exports = {
  parseParams, transformPoint, transformPolygon, buildBatch,
  ROTATIONS, MAX_TRANSLATE, MAX_PIECES,
};
