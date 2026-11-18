import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNexus, tokenize } from '../src/nexus.mjs';

function find(records, kind, predicate) {
  const record = records.filter(item => item.kind === kind).find(item => predicate(item.value));
  return record ? record.value : undefined;
}

test('交错矩阵按分段重组，MATCHCHAR/GAP/MISSING 与多态不确定分别留存', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=3; TAXLABELS 'tax a' B C; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=6; FORMAT DATATYPE=DNA GAP=- MISSING=? MATCHCHAR=. INTERLEAVE; MATRIX
 'tax a' AC
 B .?
 C AG

 'tax a' GT
 B T-
 C (AG)T

 'tax a' AC
 B AC
 C AC
; END;`;
  const { records, issues } = parseNexus(nex, 'rcpt');
  assert.equal(issues.length, 0);

  // MATCHCHAR 解析为参考分类单元同列状态，但原 token 与引用关系留存
  const matched = find(records, 'character-state', v => v.taxon === 'B' && v.character === 1);
  assert.equal(matched.kind, 'value');
  assert.deepEqual(matched.states, ['A']);
  assert.equal(matched.originalToken, '.');
  assert.equal(matched.matchchar.referenceTaxon, 'tax a');

  // MISSING 独立保留，且没有 states
  const missing = find(records, 'character-state', v => v.taxon === 'B' && v.character === 2);
  assert.equal(missing.kind, 'missing');
  assert.equal('states' in missing, false);
  assert.equal(missing.originalToken, '?');

  // GAP 独立保留
  const gap = find(records, 'character-state', v => v.taxon === 'B' && v.character === 4);
  assert.equal(gap.kind, 'gap');
  assert.equal(gap.originalToken, '-');

  // 多态 () 与普通值区分，状态拆开
  const poly = find(records, 'character-state', v => v.taxon === 'C' && v.character === 3);
  assert.equal(poly.kind, 'polymorphic');
  assert.deepEqual(poly.states, ['A', 'G']);
  assert.equal(poly.originalToken, '(AG)');

  // 交错后每个分类单元恰好 6 个字符，字符编号连续
  const perTaxon = new Map();
  for (const record of records.filter(r => r.kind === 'character-state')) {
    if (!perTaxon.has(record.value.taxon)) perTaxon.set(record.value.taxon, []);
    perTaxon.get(record.value.taxon).push(record.value.character);
  }
  for (const characters of perTaxon.values()) {
    assert.deepEqual(characters, [1, 2, 3, 4, 5, 6]);
  }
});

test('不确定状态 {} 与多态 () 区分，复合词 .{01} 不被拆散', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS X Y; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=2; FORMAT DATATYPE=STANDARD MISSING=? GAP=- MATCHCHAR=.;
MATRIX X 01
 Y .{01}
; END;`;
  const { records } = parseNexus(nex, 'rcpt');
  const uncertain = find(records, 'character-state', v => v.taxon === 'Y' && v.character === 2);
  assert.equal(uncertain.kind, 'uncertain');
  assert.deepEqual(uncertain.states, ['0', '1']);
  assert.equal(uncertain.originalToken, '{01}');
  const matched = find(records, 'character-state', v => v.taxon === 'Y' && v.character === 1);
  assert.equal(matched.originalToken, '.');
  assert.deepEqual(matched.states, ['0']);
});

test('缺失不能用上一行字符补：参考列为 gap 时 MATCHCHAR 不可解析并登记 issue', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS R S; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=1; FORMAT DATATYPE=DNA GAP=- MATCHCHAR=.;
MATRIX R -
 S .
; END;`;
  const { records, issues } = parseNexus(nex, 'rcpt');
  const state = find(records, 'character-state', v => v.taxon === 'S' && v.character === 1);
  assert.equal(state.kind, 'matchchar');
  assert.equal(state.originalToken, '.');
  assert.ok(issues.some(issue => issue.reason === 'matchchar_unresolved'));
});

test('TRANSLATE 只在所属 TREES block 内解释数字叶标签', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS R S; END;
BEGIN TREES; TRANSLATE 1 R, 2 S; TREE a=[&R](1:0.1,(2:0.2):0.3); END;
BEGIN TREES; TREE b=(1); END;`;
  const { records, issues } = parseNexus(nex, 'rcpt');
  const leafA = find(records, 'tree-leaf', v => v.tree === 'a' && v.token === '1');
  assert.equal(leafA.taxon, 'R');
  assert.equal(leafA.translated, true);
  // 第二个 TREES block 没有自己的 TRANSLATE，数字 1 保持原 token
  const leafB = find(records, 'tree-leaf', v => v.tree === 'b');
  assert.equal(leafB.token, '1');
  assert.equal(leafB.taxon, '1');
  assert.equal(leafB.translated, false);
  assert.ok(issues.some(issue => issue.reason === 'tree_leaf_untranslated_number'));
  // 分支长度不被当成叶：a 有 2 叶，无 TRANSLATE 的 b 有 1 叶
  assert.equal(records.filter(r => r.kind === 'tree-leaf').length, 3);
});

test('有根/无根只记录来源声明，未声明保持 unspecified，不自行推断', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS R S; END;
BEGIN TREES;
TREE rooted=[&R](R,S);
TREE unrooted=[&U](R,S);
TREE plain=(R,S);
END;`;
  const { records } = parseNexus(nex, 'rcpt');
  assert.equal(find(records, 'tree', v => v.tree === 'rooted').rooting, 'rooted');
  assert.equal(find(records, 'tree', v => v.tree === 'unrooted').rooting, 'unrooted');
  const plain = find(records, 'tree', v => v.tree === 'plain');
  assert.equal(plain.rooting, 'unspecified');
  assert.equal(plain.rootingSource, null);
});

test('未知 block 与未知命令整段保留并明确标识未支持', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=1; TAXLABELS X; END;
BEGIN NOTES; TEXT hello world; END;
BEGIN SETS; CUSTOMSET something 1-2; END;`;
  const { records } = parseNexus(nex, 'rcpt');
  const unknown = records.filter(r => r.kind === 'unknown-command');
  assert.equal(unknown.length, 2);
  const notes = unknown.find(r => r.value.block === 'NOTES');
  assert.equal(notes.value.supported, false);
  assert.match(notes.value.raw, /TEXT hello world/);
  const sets = unknown.find(r => r.value.block === 'SETS');
  assert.equal(sets.value.command, 'CUSTOMSET');
});

test('block 链接按 TITLE/LINK，唯一上下文自动链接，歧义不猜', () => {
  const explicit = parseNexus(`#NEXUS
BEGIN TAXA; TITLE tA; DIMENSIONS NTAX=1; TAXLABELS A; END;
BEGIN CHARACTERS; LINK tA; DIMENSIONS NCHAR=1; FORMAT DATATYPE=DNA; MATRIX A C; END;`, 'r');
  assert.equal(explicit.issues.length, 0);
  assert.equal(find(explicit.records, 'character-state', v => v.taxon === 'A').states[0], 'C');
  const ambiguous = parseNexus(`#NEXUS
BEGIN TAXA; TITLE tA; DIMENSIONS NTAX=1; TAXLABELS A; END;
BEGIN TAXA; TITLE tB; DIMENSIONS NTAX=1; TAXLABELS B; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=1; FORMAT DATATYPE=DNA; MATRIX A C; END;`, 'r');
  assert.ok(ambiguous.issues.some(issue => issue.reason === 'taxa_link_ambiguous'));

  const brokenLink = parseNexus(`#NEXUS
BEGIN TAXA; TITLE tA; DIMENSIONS NTAX=1; TAXLABELS A; END;
BEGIN CHARACTERS; LINK missing; DIMENSIONS NCHAR=1; FORMAT DATATYPE=DNA; MATRIX A C; END;`, 'r');
  assert.ok(brokenLink.issues.some(issue => issue.reason === 'link_target_missing'));
});

test('截断的 TREE 命令不产生树声明，但登记问题且已完整内容仍可解释', async () => {
  const { readFile } = await import('node:fs/promises');
  const partial = await readFile(new URL('../fixtures/study.nex.partial', import.meta.url), 'utf8');
  const { records, issues } = parseNexus(partial, 'rcpt');
  assert.equal(records.filter(r => r.kind === 'tree').length, 0);
  assert.ok(issues.some(issue => issue.reason === 'unterminated_command' && issue.detail.command === 'TREE'));
  // 截断前的矩阵与分区仍被解释
  assert.ok(records.some(r => r.kind === 'charset'));
  assert.ok(records.some(r => r.kind === 'character-state'));
  // 每条记录都带可回查出处
  for (const record of records) {
    assert.ok(record.provenance[0].receiptId === 'rcpt');
    assert.match(record.provenance[0].location, /^byte:/);
  }
});

test('嵌套注释与引号标签不被简单 split 破坏', () => {
  const tokens = tokenize("TAXLABELS 'a b''c' [outer [nested] end] D;");
  const quoted = tokens.find(t => t.type === 'quote');
  assert.equal(quoted.value, "a b'c");
  const comment = tokens.find(t => t.type === 'comment');
  assert.equal(comment.value, '[outer [nested] end]');
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS 'a b' 'c;d'; END;
BEGIN TREES; TREE t=('a b','c;d'); END;`;
  const { records, issues } = parseNexus(nex, 'rcpt');
  assert.equal(issues.length, 0);
  const leaves = records.filter(r => r.kind === 'tree-leaf').map(r => r.value.taxon);
  assert.deepEqual(leaves.sort(), ['a b', 'c;d']);
});

test('FORMAT 符号覆盖默认 GAP/MISSING/MATCHCHAR 并留存声明', () => {
  const nex = `#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=2; TAXLABELS X Y; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=2; FORMAT DATATYPE=DNA GAP=# MISSING=* MATCHCHAR=^;
MATRIX X #A
 Y ^*
; END;`;
  const { records } = parseNexus(nex, 'rcpt');
  const format = find(records, 'format', () => true);
  assert.equal(format.gap, '#');
  assert.equal(format.missing, '*');
  assert.equal(format.matchchar, '^');
  const gap = find(records, 'character-state', v => v.taxon === 'X' && v.character === 1);
  assert.equal(gap.kind, 'gap');
  const missing = find(records, 'character-state', v => v.taxon === 'Y' && v.character === 2);
  assert.equal(missing.kind, 'missing');
});

test('TAXLABELS 数量与 NTAX 不符、矩阵超出 NCHAR 都登记问题', () => {
  const mismatch = parseNexus(`#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=3; TAXLABELS A B; END;`, 'r');
  assert.ok(mismatch.issues.some(i => i.reason === 'taxlabel_count_mismatch'));

  const excess = parseNexus(`#NEXUS
BEGIN TAXA; DIMENSIONS NTAX=1; TAXLABELS A; END;
BEGIN CHARACTERS; DIMENSIONS NCHAR=1; FORMAT DATATYPE=DNA; MATRIX A AC; END;`, 'r');
  assert.ok(excess.issues.some(i => i.reason === 'matrix_excess_states'));
});
