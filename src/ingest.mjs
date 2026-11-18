// 自动接入编排：领取交付入口与 roots，每份原文都登记真实收件，
// 再对 NEXUS 来源做结构化解释。失败不静默，统一登记为带出处的 issue。
import { retrieve } from './transport.mjs';
import { parseNexus } from './nexus.mjs';

function isNexus(bytes, mediaType) {
  if (/nexus/i.test(mediaType || '')) return true;
  return /^#NEXUS/i.test(bytes.toString('utf8').replace(/^﻿/, ''));
}

function joinUrl(entry, href) {
  return new URL(href, entry).href;
}

// 读取交付索引（delivery-index）。不是索引时返回 null，由调用方按单文件入口处理。
function readDeliveryIndex(bytes, mediaType) {
  if (!/json/i.test(mediaType || '')) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value && Array.isArray(value.roots)) return value;
  } catch {}
  return null;
}

export async function ingest({ archive, collectionId, entry, allowedOrigin }) {
  const receiptIds = [];
  const issues = [];
  const seen = new Set();

  const fetchAndReceive = async (url, sourceKey) => {
    if (seen.has(url)) return null;
    seen.add(url);
    const result = await retrieve(url, allowedOrigin);
    const receipt = await archive.receive({
      collectionId, sourceKey: sourceKey || url, revision: result.revision,
      mediaType: result.mediaType, bytes: result.bytes, summary: undefined
    });
    if (!receiptIds.includes(receipt.receiptId)) receiptIds.push(receipt.receiptId);
    return { receipt, bytes: result.bytes, mediaType: result.mediaType };
  };

  // 入口来源在任何请求发出前冻结校验：不在授权 origin 直接拒绝，不登记为普通 issue。
  const entryUrl = new URL(entry);
  if (entryUrl.origin !== allowedOrigin || entryUrl.username || entryUrl.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }

  // 入口本身先留底（通常是 delivery 索引，也可能直接是 NEXUS 正文）
  let entryPayload;
  try {
    entryPayload = await fetchAndReceive(entry, entry);
  } catch (error) {
    if (error.status) throw error;
    issues.push({ reason: 'entry_unavailable', location: `url:${entry}`, detail: error.message });
    return { receiptIds, issues };
  }

  const index = readDeliveryIndex(entryPayload.bytes, entryPayload.mediaType);
  const rootHrefs = [];
  if (index) {
    for (const root of index.roots) {
      if (root && typeof root.href === 'string') rootHrefs.push(joinUrl(entry, root.href));
    }
  } else if (isNexus(entryPayload.bytes, entryPayload.mediaType)) {
    rootHrefs.push(entry);
  } else {
    issues.push({ reason: 'unsupported_entry_format', location: `receipt:${entryPayload.receipt.receiptId}`,
      detail: { mediaType: entryPayload.mediaType } });
  }

  for (const url of rootHrefs) {
    let payload;
    try {
      payload = await fetchAndReceive(url, url);
    } catch (error) {
      issues.push({ reason: 'root_unavailable', location: `url:${url}`, detail: error.message });
      continue;
    }
    if (!payload) continue;
    if (!isNexus(payload.bytes, payload.mediaType)) {
      issues.push({ reason: 'unsupported_root_format', location: `receipt:${payload.receipt.receiptId}`,
        detail: { mediaType: payload.mediaType } });
      continue;
    }
    let parsed;
    try {
      parsed = parseNexus(payload.bytes.toString('utf8'), payload.receipt.receiptId);
    } catch (error) {
      issues.push({ reason: 'nexus_parse_failed', location: `receipt:${payload.receipt.receiptId}`, detail: error.message });
      continue;
    }
    for (const record of parsed.records) {
      try {
        await archive.addRecord(collectionId, record);
      } catch (error) {
        // 同键不可变冲突必须显式登记，不能覆盖已归档解释
        issues.push({ reason: 'record_conflict', location: `record:${record.kind}:${record.key}`, detail: error.message });
      }
    }
    for (const item of parsed.issues) {
      issues.push({ ...item, provenance: [{ receiptId: payload.receipt.receiptId, location: item.location }] });
    }
  }

  for (const issue of issues) await archive.addIssue(collectionId, issue);
  return { receiptIds, issues };
}
