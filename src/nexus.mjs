// NEXUS 解释器：把来源正文转成带出处的结构化观察。
// 设计约束（见 docs/source-contract.md）：
// - TRANSLATE 只在所属 TREES block 内生效，数字叶标签不是全局物种编号；
// - FORMAT 的 GAP / MISSING / MATCHCHAR 与多态 ()、不确定 {} 分别保留，MATCHCHAR 原 token 留存；
// - 交错（INTERLEAVE）矩阵分段重组，绝不以上一行字符补缺失；
// - 有根/无根只记录来源声明（[&R]/[&U]），不推断；未知命令整段保留；
// - block 与分类单元的链接按 TITLE/LINK 与唯一上下文解释，歧义不猜，登记 issue。

const WORD_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./*+\\?{}-");
// 圆括号始终是 Newick 结构标点；花括号是不确定状态分组，随词保留并在矩阵层解释。
const PUNCT = new Set('=;:(),');

// 词法扫描：支持嵌套 [..] 注释、单引号标签（'' 转义）、空白与单字符标点。
// 圆括号始终是 Newick 结构标点；MATRIX 的状态分组 (AG)/{01} 在矩阵扫描层重组。
// 每个 token 携带 1 起行列与绝对字节区间。
export function tokenize(text) {
  const tokens = [];
  let line = 1;
  let column = 1;
  let i = 0;
  const advance = (count = 1) => {
    for (let n = 0; n < count; n += 1) {
      if (text[i] === '\n') { line += 1; column = 1; } else column += 1;
      i += 1;
    }
  };
  const push = (type, value, start, end, line0, column0, endLine = line, endColumn = column) => {
    tokens.push({ type, value, byte: start, byteEnd: end, line: line0, column: column0, endLine, endColumn });
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(); continue; }
    if (ch === '[') {
      const start = i;
      const line0 = line;
      const column0 = column;
      let depth = 0;
      do {
        if (text[i] === '[') depth += 1;
        if (text[i] === ']') depth -= 1;
        advance();
      } while (i < text.length && depth > 0);
      push('comment', text.slice(start, i), start, i, line0, column0);
      continue;
    }
    if (ch === "'") {
      const start = i;
      const line0 = line;
      const column0 = column;
      let value = '';
      advance(); // 开引号
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { value += "'"; advance(2); continue; }
          advance(); // 闭引号
          break;
        }
        value += text[i];
        advance();
      }
      push('quote', value, start, i, line0, column0);
      continue;
    }
    if (PUNCT.has(ch)) {
      push(ch, ch, i, i + 1, line, column);
      advance();
      continue;
    }
    const start = i;
    const line0 = line;
    const column0 = column;
    while (i < text.length && WORD_CHARS.has(text[i])) advance();
    if (i === start) {
      // 无法识别的孤立字符（如 @、#）：作为单词保留，避免静默丢字符
      advance();
    }
    push('word', text.slice(start, i), start, i, line0, column0);
  }
  return tokens;
}

function isWord(token) {
  return token && (token.type === 'word' || token.type === 'quote');
}

// 跳过 = 与注释，取下一个词法词。
function nextWord(tokens, index) {
  let i = index;
  while (i < tokens.length && (tokens[i].type === '=' || tokens[i].type === 'comment')) i += 1;
  return isWord(tokens[i]) ? { value: tokens[i].value, token: tokens[i], index: i } : undefined;
}

function pointLocation(token, charOffset = 0) {
  return { byte: token.byte + charOffset, line: token.line, column: token.column + charOffset };
}

function spanLocation(token) {
  return { byteStart: token.byte, byteEnd: token.byteEnd, line: token.line, column: token.column, endLine: token.endLine, endColumn: token.endColumn };
}

function locText(location) {
  if (location.byteStart !== undefined) {
    return `byte:${location.byteStart}-${location.byteEnd};line:${location.line},${location.column}-${location.endLine},${location.endColumn}`;
  }
  return `byte:${location.byte};line:${location.line},${location.column}`;
}

// 把命令 token 序列拼成可读原文，用于未知命令留存（注释不进入 raw）。
function rawCommandText(tokens) {
  return tokens.filter(token => token.type !== 'comment').map(token => {
    if (token.type === 'quote') return `'${token.value.replaceAll("'", "''")}'`;
    return token.value;
  }).join(' ');
}

export function parseNexus(textInput, receiptId = 'unknown') {
  const text = textInput.replace(/^﻿/, '');
  const tokens = tokenize(text);
  const records = [];
  const issues = [];
  const blocks = [];
  const taxaBlocks = [];

  const provenance = location => [{ receiptId, location: locText(location) }];
  const issue = (reason, location, detail) => {
    issues.push({ reason, location: locText(location), ...(detail ? { detail } : {}) });
  };
  const emit = (kind, key, value, location) => {
    records.push({ kind, key, value, provenance: provenance(location) });
  };

  // ---------- 顶层 block 切分 ----------
  let blockOrdinal = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (isWord(token) && token.value.toUpperCase() === 'BEGIN') {
      const nameToken = tokens[i + 1];
      const block = { index: blockOrdinal, name: nameToken ? nameToken.value.toUpperCase() : 'UNKNOWN',
        title: undefined, link: undefined, titleToken: undefined, linkToken: undefined,
        startToken: token, bodyStart: i + 2, commands: [], endIndex: tokens.length };
      blockOrdinal += 1;
      let j = i + 2;
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        if (isWord(tokens[j]) && tokens[j].value.toUpperCase() === 'BEGIN') depth += 1;
        if (isWord(tokens[j]) && (tokens[j].value.toUpperCase() === 'END' || tokens[j].value.toUpperCase() === 'ENDBLOCK')) depth -= 1;
        if (depth === 0) break;
        j += 1;
      }
      block.endIndex = j;
      block.commands = splitCommands(tokens, block.bodyStart, j);
      parseHeader(block);
      blocks.push(block);
      if (block.name === 'TAXA') taxaBlocks.push(block);
      i = j + 1;
      continue;
    }
    i += 1;
  }

  function parseHeader(block) {
    for (const command of block.commands) {
      const head = command.tokens[0];
      if (!head) continue;
      const keyword = head.value.toUpperCase();
      if (keyword === 'TITLE') {
        const named = nextWord(command.tokens, 1);
        if (named) { block.title = named.value; block.titleToken = named.token; }
      } else if (keyword === 'LINK') {
        const named = nextWord(command.tokens, 1);
        if (named) { block.link = named.value; block.linkToken = named.token; }
      }
    }
  }

  function splitCommands(all, start, end) {
    const commands = [];
    let current = [];
    for (let k = start; k < end; k += 1) {
      const token = all[k];
      if (token.type === ';') {
        if (current.length) commands.push({ tokens: current, semicolon: token });
        current = [];
      } else {
        current.push(token);
      }
    }
    if (current.length) commands.push({ tokens: current, semicolon: undefined });
    return commands;
  }

  // ---------- 各 block 语义解析 ----------
  for (const block of blocks) {
    if (block.name === 'TAXA') parseTaxaBlock(block);
    else if (block.name === 'CHARACTERS' || block.name === 'DATA') parseCharactersBlock(block);
    else if (block.name === 'SETS') parseSetsBlock(block);
    else if (block.name === 'TREES') parseTreesBlock(block);
    else preserveUnknownBlock(block);
  }

  function parseTaxaBlock(block) {
    block.taxa = [];
    block.ntax = undefined;
    for (const command of block.commands) {
      const head = command.tokens[0];
      if (!head) continue;
      const keyword = head.value.toUpperCase();
      if (keyword === 'DIMENSIONS') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (isWord(tk) && tk.value.toUpperCase().startsWith('NTAX')) {
            const named = nextWord(command.tokens, k + 1);
            if (named) block.ntax = Number(named.value);
          }
        }
      } else if (keyword === 'TAXLABELS') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (isWord(tk)) {
            block.taxa.push({ name: tk.value, token: tk });
            emit('taxon', `b${block.index}:taxon:${tk.value}`,
              { block: block.index, name: tk.value, ordinal: block.taxa.length }, spanLocation(tk));
          }
        }
      } else if (keyword !== 'TITLE' && keyword !== 'LINK') {
        preserveUnknownCommand(block, command);
      }
      if (!command.semicolon) issue('unterminated_command', spanLocation(head), { command: keyword, block: block.name });
    }
    if (block.ntax !== undefined && block.taxa.length !== block.ntax) {
      issue('taxlabel_count_mismatch', spanLocation(block.startToken), { declared: block.ntax, observed: block.taxa.length });
    }
  }

  function parseCharactersBlock(block) {
    block.format = { datatype: null, gap: '-', missing: '?', matchchar: '.', interleave: false, tokens: false, symbols: null };
    block.nchar = undefined;
    block.ntax = undefined;
    block.matrix = undefined;
    block.ownTaxlabels = [];
    for (const command of block.commands) {
      const head = command.tokens[0];
      if (!head) {
        if (!command.semicolon) issue('unterminated_command', { byte: text.length, line: lastLine(), column: 1 }, { block: block.name });
        continue;
      }
      const keyword = head.value.toUpperCase();
      if (keyword === 'DIMENSIONS') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (!isWord(tk)) continue;
          const upper = tk.value.toUpperCase();
          if (upper.startsWith('NCHAR')) {
            const named = nextWord(command.tokens, k + 1);
            if (named) block.nchar = Number(named.value);
          } else if (upper.startsWith('NTAX')) {
            const named = nextWord(command.tokens, k + 1);
            if (named) block.ntax = Number(named.value);
          }
        }
      } else if (keyword === 'FORMAT') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (!isWord(tk)) continue;
          const upper = tk.value.toUpperCase();
          if (upper === 'INTERLEAVE') block.format.interleave = true;
          else if (upper === 'TOKENS') block.format.tokens = true;
          else if (upper === 'DATATYPE') {
            const named = nextWord(command.tokens, k + 1);
            if (named) block.format.datatype = named.value.toUpperCase();
          } else if (upper === 'GAP' || upper === 'MISSING' || upper === 'MATCHCHAR') {
            const named = nextWord(command.tokens, k + 1);
            if (named) block.format[upper.toLowerCase()] = named.value;
          } else if (upper === 'SYMBOLS') {
            block.format.symbols = command.tokens.slice(k + 1).filter(isWord).map(item => item.value);
          }
        }
        emit('format', `b${block.index}:format`, { block: block.index, ...block.format }, spanLocation(head));
      } else if (keyword === 'MATRIX') {
        block.matrix = parseMatrix(block, command);
      } else if (keyword === 'TAXLABELS') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (isWord(tk)) block.ownTaxlabels.push({ name: tk.value, token: tk });
        }
      } else if (keyword !== 'TITLE' && keyword !== 'LINK') {
        preserveUnknownCommand(block, command);
      }
      if (!command.semicolon) issue('unterminated_command', spanLocation(head), { command: keyword, block: block.name });
    }
  }

  // ---------- 矩阵：按物理行重组，支持 INTERLEAVE ----------
  // (..)/{..} 分组（多态/不确定）跨标点重组为一个单元，引号状态整体保留。
  function scanStateUnits(block, stateTokens) {
    const units = [];
    let k = 0;
    while (k < stateTokens.length) {
      const tk = stateTokens[k];
      if (tk.type === '(' || tk.type === '{') {
        const open = tk;
        const closeType = tk.type === '(' ? ')' : '}';
        const words = [];
        let depth = 1;
        let j = k + 1;
        while (j < stateTokens.length && depth > 0) {
          const inner = stateTokens[j];
          if (inner.type === tk.type) depth += 1;
          else if (inner.type === closeType) depth -= 1;
          if (depth > 0 && isWord(inner)) words.push(inner);
          j += 1;
        }
        const close = stateTokens[j - 1] || open;
        // 非 TOKENS（如 DNA 连续字符）：分组内每个词再逐字符拆成状态符号。
        const parts = block.format.tokens
          ? words.map(item => item.value)
          : words.flatMap(item => Array.from(item.value));
        const raw = (open.type === '(' ? '(' : '{') + words.map(item => item.value).join('') + (open.type === '(' ? ')' : '}');
        units.push({ raw, startToken: open, endToken: close, parts, grouped: open.type === '(' ? 'polymorphic' : 'uncertain' });
        k = j;
        continue;
      }
      if (tk.type === 'word' && (tk.value.startsWith('(') || tk.value.startsWith('{'))) {
        // 非 TOKENS 连续词可能把整个分组词化（如 DNA 的 (AG)、{01}），按起止括号整体处理。
        const openChar = tk.value[0];
        const closeChar = openChar === '(' ? ')' : '}';
        const inner = tk.value.slice(1, tk.value.endsWith(closeChar) ? -1 : tk.value.length);
        const parts = block.format.tokens ? [inner] : Array.from(inner);
        units.push({ raw: tk.value, startToken: tk, endToken: tk, parts,
          grouped: openChar === '(' ? 'polymorphic' : 'uncertain' });
        k += 1;
        continue;
      }
      if (tk.type === 'word' && /[({]/.test(tk.value)) {
        // 复合词（如 .{01}）：先逐字符剥离前导普通/特殊符号，再整体处理分组段。
        let offset = 0;
        while (offset < tk.value.length && tk.value[offset] !== '(' && tk.value[offset] !== '{') {
          const raw = tk.value[offset];
          units.push({ raw, startToken: tk, endToken: tk, parts: [raw], grouped: null, charOffset: offset });
          offset += 1;
        }
        const openChar = tk.value[offset];
        if (openChar) {
          const closeChar = openChar === '(' ? ')' : '}';
          const rest = tk.value.slice(offset);
          const inner = rest.endsWith(closeChar) ? rest.slice(1, -1) : rest.slice(1);
          const parts = block.format.tokens ? [inner] : Array.from(inner);
          units.push({ raw: rest, startToken: tk, endToken: tk, parts,
            grouped: openChar === '(' ? 'polymorphic' : 'uncertain', charOffset: offset });
        }
        k += 1;
        continue;
      }
      if (tk.type === 'quote') {
        units.push({ raw: tk.value, startToken: tk, endToken: tk, parts: [tk.value], grouped: null });
        k += 1;
        continue;
      }
      if (tk.type === 'word') {
        if (!block.format.tokens && tk.value.length > 1) {
          for (let c = 0; c < tk.value.length; c += 1) {
            units.push({ raw: tk.value[c], startToken: tk, endToken: tk, parts: [tk.value[c]], grouped: null, charOffset: c });
          }
        } else {
          units.push({ raw: tk.value, startToken: tk, endToken: tk, parts: [tk.value], grouped: null });
        }
      }
      k += 1;
    }
    return units;
  }

  // ---------- 矩阵：按物理行重组，支持 INTERLEAVE ----------
  function parseMatrix(block, command) {
    const matrixTokens = command.tokens.slice(1).filter(tk => tk.type !== 'comment' && tk.type !== ';');
    const lines = [];
    let currentLine = [];
    for (const tk of matrixTokens) {
      if (currentLine.length && tk.line !== currentLine[0].line) {
        lines.push(currentLine);
        currentLine = [];
      }
      currentLine.push(tk);
    }
    if (currentLine.length) lines.push(currentLine);

    const rows = [];
    let referenceName;
    let referenceToken;
    for (const lineTokens of lines) {
      if (!lineTokens.length) continue;
      const labelToken = lineTokens[0];
      if (!isWord(labelToken)) { issue('matrix_label_missing', spanLocation(labelToken)); continue; }
      const taxon = labelToken.value;
      if (referenceName === undefined) { referenceName = taxon; referenceToken = labelToken; }
      const states = [];
      for (const unit of scanStateUnits(block, lineTokens.slice(1))) {
        if (unit.grouped) {
          const location = unit.endToken !== unit.startToken
            ? { byte: unit.startToken.byte, byteEnd: unit.endToken.byteEnd,
              line: unit.startToken.line, column: unit.startToken.column,
              endLine: unit.endToken.endLine, endColumn: unit.endToken.endColumn }
            : { byte: unit.startToken.byte + (unit.charOffset ?? 0),
              byteEnd: unit.startToken.byteEnd, line: unit.startToken.line,
              column: unit.startToken.column + (unit.charOffset ?? 0),
              endLine: unit.startToken.endLine, endColumn: unit.startToken.endColumn };
          const base = { raw: unit.raw, location };
          if (unit.raw === block.format.missing) states.push({ ...base, kind: 'missing' });
          else if (unit.raw === block.format.gap) states.push({ ...base, kind: 'gap' });
          else states.push({ ...base, kind: unit.grouped, states: unit.parts });
        } else {
          const location = pointLocation(unit.startToken, unit.charOffset ?? 0);
          const raw = unit.raw;
          const base = { raw, location };
          if (raw === block.format.missing) states.push({ ...base, kind: 'missing' });
          else if (raw === block.format.gap) states.push({ ...base, kind: 'gap' });
          else if (raw === block.format.matchchar) states.push({ ...base, kind: 'matchchar' });
          else states.push({ ...base, kind: 'value', states: [raw] });
        }
      }
      rows.push({ taxon, labelToken, states, line: labelToken.line });
    }

    // 交错分段：同一分类单元多行按顺序接续；非交错每个分类单元只允许一行。
    const taxa = [];
    for (const row of rows) {
      let entry = taxa.find(candidate => candidate.name === row.taxon);
      if (!entry) {
        entry = { name: row.taxon, states: [], labelToken: row.labelToken };
        taxa.push(entry);
      } else if (!block.format.interleave) {
        issue('matrix_duplicate_taxon_row', spanLocation(row.labelToken), { taxon: row.taxon });
      }
      entry.states.push(...row.states);
    }

    return { taxa, referenceName, referenceToken, interleave: block.format.interleave, rows };
  }

  function parseSetsBlock(block) {
    block.charsets = [];
    for (const command of block.commands) {
      const head = command.tokens[0];
      if (!head) continue;
      const keyword = head.value.toUpperCase();
      if (keyword === 'CHARSET') {
        const named = nextWord(command.tokens, 1);
        if (!named) { issue('charset_missing_name', spanLocation(head)); continue; }
        const elements = [];
        for (let k = named.index + 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (tk.type === '=' || tk.type === 'comment' || !isWord(tk)) continue;
          const range = tk.value.match(/^(\d+)-(\d+)$/);
          if (range) elements.push({ from: Number(range[1]), to: Number(range[2]) });
          else if (/^\d+$/.test(tk.value)) elements.push({ from: Number(tk.value), to: Number(tk.value) });
          else elements.push({ name: tk.value });
        }
        const charset = { name: named.value, elements, raw: rawCommandText(command.tokens) };
        block.charsets.push(charset);
        emit('charset', `b${block.index}:charset:${named.value}`, { block: block.index, ...charset }, spanLocation(head));
      } else if (keyword !== 'TITLE' && keyword !== 'LINK') {
        preserveUnknownCommand(block, command);
      }
      if (!command.semicolon) issue('unterminated_command', spanLocation(head), { command: keyword, block: block.name });
    }
  }

  function parseTreesBlock(block) {
    block.translate = new Map();
    block.translateTokens = new Map();
    block.trees = [];
    for (const command of block.commands) {
      const head = command.tokens[0];
      if (!head) {
        if (!command.semicolon) issue('unterminated_command', { byte: text.length, line: lastLine(), column: 1 }, { block: 'TREES' });
        continue;
      }
      const keyword = head.value.toUpperCase();
      if (keyword === 'TRANSLATE') {
        for (let k = 1; k < command.tokens.length; k += 1) {
          const keyToken = command.tokens[k];
          if (!isWord(keyToken)) continue;
          const named = nextWord(command.tokens, k + 1);
          if (!named) { issue('translate_missing_target', spanLocation(keyToken), { token: keyToken.value }); continue; }
          block.translate.set(keyToken.value, named.value);
          block.translateTokens.set(keyToken.value, { keyToken, targetToken: named.token });
          k = named.index;
        }
      } else if (keyword === 'TREE' || keyword === 'TREE*') {
        if (!command.semicolon) {
          // 截断的树声明没有完整 Newick，不产生树/叶记录，只登记问题。
          issue('unterminated_command', spanLocation(head), { command: keyword, block: 'TREES' });
          continue;
        }
        const named = nextWord(command.tokens, 1);
        if (!named) { issue('tree_missing_name', spanLocation(head)); continue; }
        const treeName = named.value;
        // 根性声明只看来源注释 [&R]/[&U]，出现位置在 Newick 之前；不自行推断。
        let rooting = 'unspecified';
        let rootingToken = null;
        for (let k = named.index + 1; k < command.tokens.length; k += 1) {
          const tk = command.tokens[k];
          if (tk.type === 'comment') {
            const match = tk.value.match(/&([RU])/);
            if (match) { rooting = match[1] === 'R' ? 'rooted' : 'unrooted'; rootingToken = tk; }
          } else if (isWord(tk) || tk.type === '(') break;
        }
        const newickTokens = command.tokens.slice(named.index + 1).filter(tk => tk.type !== 'comment' && tk.type !== '=');
        const newick = newickTokens.map(tk => tk.type === 'quote' ? `'${tk.value.replaceAll("'", "''")}'` : tk.value).join('');
        const leaves = extractLeaves(newickTokens, block);
        block.trees.push({ name: treeName, rooting, rootingToken, newick, leaves, headToken: head, nameToken: named.token });
      } else if (keyword !== 'TITLE' && keyword !== 'LINK') {
        preserveUnknownCommand(block, command);
      }
      if (!command.semicolon) issue('unterminated_command', spanLocation(head), { command: keyword, block: 'TREES' });
    }
  }

  // 从 Newick token 流提取叶标签；数字 token 仅经本 block TRANSLATE 解释。
  function extractLeaves(newickTokens, block) {
    const leaves = [];
    let occurrence = 0;
    for (let k = 0; k < newickTokens.length; k += 1) {
      const tk = newickTokens[k];
      const after = newickTokens[k + 1];
      // ':' 之后是分支长度/支持率，不是叶名；内部节点名后随 '('。
      if (k > 0 && newickTokens[k - 1].type === ':') continue;
      if (isWord(tk) && (!after || after.type !== '(')) {
        const token = tk.value;
        let taxon;
        let translated = false;
        if (block.translate.has(token)) { taxon = block.translate.get(token); translated = true; }
        else taxon = token;
        occurrence += 1;
        leaves.push({ token, taxon, translated, occurrence, tokenObject: tk });
        if (!translated && /^\d+$/.test(token)) {
          issue('tree_leaf_untranslated_number', spanLocation(tk), { token, block: block.index });
        }
      }
    }
    return leaves;
  }

  function preserveUnknownCommand(block, command) {
    const head = command.tokens[0];
    if (!head) return;
    emit('unknown-command', `b${block.index}:unknown:${head.line}:${head.column}`, {
      block: block.name, command: head.value, raw: rawCommandText(command.tokens), supported: false
    }, spanLocation(head));
  }

  function preserveUnknownBlock(block) {
    for (const command of block.commands) preserveUnknownCommand(block, command);
  }

  function lastLine() {
    return tokens.length ? tokens[tokens.length - 1].endLine : 1;
  }

  // ---------- block 与分类单元链接：TITLE/LINK 与唯一上下文，歧义不猜 ----------
  const taxaByTitle = new Map();
  for (const block of taxaBlocks) {
    if (block.title) taxaByTitle.set(block.title, block);
  }
  for (const block of blocks) {
    if (block.name === 'TAXA') continue;
    if (block.link) {
      const target = taxaByTitle.get(block.link);
      if (target) block.linkedTaxa = target;
      else issue('link_target_missing', block.linkToken ? spanLocation(block.linkToken) : spanLocation(block.startToken),
        { link: block.link, block: block.name });
    } else if (taxaBlocks.length === 1) {
      block.linkedTaxa = taxaBlocks[0];
    } else if (taxaBlocks.length > 1) {
      issue('taxa_link_ambiguous', spanLocation(block.startToken),
        { block: block.name, candidates: taxaBlocks.map(b => b.title ?? `b${b.index}`) });
    }
  }

  // DATA block 自带 TAXLABELS 时作为自身分类单元集合
  for (const block of blocks) {
    if (block.name === 'DATA' && !block.linkedTaxa && block.ownTaxlabels.length) {
      block.implicitTaxa = block.ownTaxlabels.map(entry => entry.name);
      block.ownTaxlabels.forEach((entry, ordinal) => {
        emit('taxon', `b${block.index}:taxon:${entry.name}`, { block: block.index, name: entry.name, ordinal }, spanLocation(entry.token));
      });
    }
  }

  function taxaNamesOf(block) {
    if (block.linkedTaxa) return block.linkedTaxa.taxa.map(entry => entry.name);
    if (block.implicitTaxa) return block.implicitTaxa;
    if (block.ownTaxlabels?.length) return block.ownTaxlabels.map(entry => entry.name);
    return block.matrix ? block.matrix.taxa.map(entry => entry.name) : [];
  }

  // ---------- 字符声明与字符状态 ----------
  for (const block of blocks) {
    if (block.name !== 'CHARACTERS' && block.name !== 'DATA') continue;
    const names = taxaNamesOf(block);
    block.taxaNames = names;
    if (block.nchar === undefined) issue('nchar_undeclared', spanLocation(block.startToken), { block: block.index });
    const declared = block.nchar ?? Math.max(0, ...(block.matrix ? block.matrix.taxa.map(entry => entry.states.length) : [0]));
    for (let character = 1; character <= declared; character += 1) {
      emit('character', `b${block.index}:character:${character}`,
        { block: block.index, character, datatype: block.format.datatype }, spanLocation(block.startToken));
    }
    if (!block.matrix) continue;
    const matrix = block.matrix;
    if (matrix.referenceName !== undefined && !names.includes(matrix.referenceName)) {
      issue('matrix_reference_taxon_unknown', spanLocation(matrix.referenceToken), { taxon: matrix.referenceName });
    }
    for (const entry of matrix.taxa) {
      if (!names.includes(entry.name)) issue('matrix_taxon_unknown', spanLocation(entry.labelToken), { taxon: entry.name });
    }
    const referenceEntry = matrix.taxa.find(candidate => candidate.name === matrix.referenceName);

    for (const entry of matrix.taxa) {
      entry.states.forEach((state, zeroIndex) => {
        const character = zeroIndex + 1;
        const value = { taxon: entry.name, character, kind: state.kind, block: block.index, originalToken: state.raw };
        if (state.kind === 'polymorphic' || state.kind === 'uncertain' || state.kind === 'value') value.states = state.states;

        if (state.kind === 'matchchar') {
          // MATCHCHAR 引用同列参考分类单元；原 token 留存，绝不以上一行字符补缺失。
          value.matchchar = { referenceTaxon: matrix.referenceName };
          const referenceState = referenceEntry ? referenceEntry.states[zeroIndex] : undefined;
          if (referenceState && (referenceState.kind === 'value' || referenceState.kind === 'polymorphic' || referenceState.kind === 'uncertain')) {
            value.kind = referenceState.kind;
            value.states = referenceState.states;
          } else {
            value.kind = 'matchchar';
            issue('matchchar_unresolved', state.location, { taxon: entry.name, character, referenceTaxon: matrix.referenceName });
          }
        }
        emit('character-state', `b${block.index}:state:${entry.name}:${character}`, value, state.location);
      });
    }

    // 截断/缺件：每个分类单元的字符数应与 NCHAR 一致，缺失不能静默。
    if (block.nchar !== undefined) {
      for (const entry of matrix.taxa) {
        if (entry.states.length < block.nchar) {
          issue('matrix_truncated', spanLocation(entry.labelToken),
            { taxon: entry.name, observed: entry.states.length, expected: block.nchar });
        } else if (entry.states.length > block.nchar) {
          issue('matrix_excess_states', spanLocation(entry.labelToken),
            { taxon: entry.name, observed: entry.states.length, expected: block.nchar });
        }
      }
    }
  }

  // ---------- TREES：translate、树声明与树叶 ----------
  for (const block of blocks.filter(b => b.name === 'TREES')) {
    const names = taxaNamesOf(block);
    block.taxaNames = names;
    for (const [token, target] of block.translate) {
      const located = block.translateTokens.get(token);
      if (!names.includes(target)) issue('translate_target_unknown', spanLocation(located.targetToken), { token, target });
      emit('translate', `b${block.index}:translate:${token}`,
        { block: block.index, token, taxon: target }, spanLocation(located.keyToken));
    }
    for (const tree of block.trees) {
      emit('tree', `b${block.index}:tree:${tree.name}`, {
        block: block.index, tree: tree.name, rooting: tree.rooting,
        rootingSource: tree.rootingToken ? tree.rootingToken.value : null, newick: tree.newick
      }, spanLocation(tree.headToken));
      for (const leaf of tree.leaves) {
        if (leaf.translated && !names.includes(leaf.taxon)) {
          issue('tree_leaf_taxon_unknown', spanLocation(leaf.tokenObject), { tree: tree.name, taxon: leaf.taxon });
        }
        emit('tree-leaf', `b${block.index}:tree:${tree.name}:leaf:${leaf.occurrence}`,
          { tree: tree.name, token: leaf.token, taxon: leaf.taxon, translated: leaf.translated },
          spanLocation(leaf.tokenObject));
      }
    }
  }

  return {
    records, issues,
    blocks: blocks.map(({ index, name, title, link }) => ({ index, name, title, link }))
  };
}
