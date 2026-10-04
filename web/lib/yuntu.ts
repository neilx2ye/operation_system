import type { OrderDetail } from '@/lib/mock';

// 云途 OMS API。字段名依据官方《云途物流API接口开发规范(OMS版)》,上线前请逐字段对照官方 PDF 核对。
// 认证: Authorization: Basic base64(客户编号&ApiSecret)

import { loadSettings, yuntuReady } from '@/lib/settings';
import { orderWeight, unitKg, type ManualOrder } from '@/lib/shipTypes';

export type YuntuConfig = { baseUrl: string; customerCode: string; apiSecret: string; channelCode: string; unitWeightKg: number };

export async function yuntuConfig(): Promise<YuntuConfig | null> {
  const s = await loadSettings();
  if (!yuntuReady(s)) return null;
  const y = s.yuntu;
  return { baseUrl: y.baseUrl.replace(/\/+$/, ''), customerCode: y.customerCode, apiSecret: y.apiSecret, channelCode: y.channelCode, unitWeightKg: Number(y.unitWeightKg) || 0.3 };
}

export type YuntuResult = { waybillNumber: string; trackingNumber: string; raw: unknown };

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || parts[0] || '' };
}

export function buildYuntuOrder(d: OrderDetail, cfg: YuntuConfig) {
  const n = splitName(d.shipping.name);
  const parcels = d.lines
    .filter((l) => !l.refunded)
    .map((l) => ({
      EnglishName: l.product,
      ChineseName: l.product,
      Quantity: l.qty,
      UnitPrice: Number(l.price.toFixed(2)),
      UnitWeight: unitKg(l.weightG, cfg.unitWeightKg),
      CurrencyCode: 'USD',
      SKU: l.sku,
    }));
  const totalKg = orderWeight(d.lines, cfg.unitWeightKg).totalKg;
  return {
    CustomerOrderNumber: d.id.replace('#', ''),
    ShippingMethodCode: cfg.channelCode,
    PackageCount: 1,
    Weight: totalKg,
    Receiver: {
      CountryCode: d.shipping.country,
      FirstName: n.first,
      LastName: n.last,
      Street: d.shipping.line1,
      StreetAddress1: d.shipping.line2,
      City: d.shipping.city,
      State: d.shipping.state,
      Zip: d.shipping.zip,
      Phone: d.shipping.phone,
    },
    Parcels: parcels,
  };
}

export function buildManualOrder(orderNo: string, m: ManualOrder) {
  const n = splitName(m.receiver.name);
  const parcels = m.parcels.map((p) => ({
    EnglishName: p.englishName,
    ChineseName: p.chineseName || p.englishName,
    Quantity: p.qty,
    UnitPrice: Number(p.unitPrice.toFixed(2)),
    UnitWeight: p.unitWeightKg,
    CurrencyCode: m.currency || 'USD',
    SKU: p.sku || '',
  }));
  return {
    CustomerOrderNumber: orderNo.replace('#', ''),
    ShippingMethodCode: m.channelCode,
    PackageCount: 1,
    Weight: Number(m.parcels.reduce((s, p) => s + p.qty * p.unitWeightKg, 0).toFixed(3)),
    Receiver: {
      CountryCode: m.receiver.country.toUpperCase(),
      FirstName: n.first,
      LastName: n.last,
      Street: m.receiver.line1,
      StreetAddress1: m.receiver.line2,
      City: m.receiver.city,
      State: m.receiver.state,
      Zip: m.receiver.zip,
      Phone: m.receiver.phone,
    },
    Parcels: parcels,
  };
}

export async function createYuntuOrder(d: OrderDetail, cfg: YuntuConfig, manual?: ManualOrder): Promise<YuntuResult> {
  const token = Buffer.from(cfg.customerCode + '&' + cfg.apiSecret).toString('base64');
  const res = await fetch(cfg.baseUrl + '/api/WayBill/CreateOrder', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify([manual ? buildManualOrder(d.id, manual) : buildYuntuOrder(d, cfg)]),
    signal: AbortSignal.timeout(20000),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('云途 HTTP ' + res.status);
  if (json.Code !== undefined && String(json.Code) !== '0000') throw new Error('云途返回错误: ' + (json.Message || json.Code));
  const item = json.Item?.[0] ?? json.Result?.Items?.[0] ?? json.Items?.[0];
  if (!item) throw new Error('云途返回无运单数据: ' + JSON.stringify(json).slice(0, 300));
  if (item.Success === 0 || item.Success === false) throw new Error('云途订单失败: ' + (item.Remark || item.Message || JSON.stringify(item)));
  const waybillNumber = String(item.WayBillNumber || item.WaybillNumber || '');
  const trackingNumber = String(item.TrackingNumber || item.TrackNumber || waybillNumber);
  if (!waybillNumber && !trackingNumber) throw new Error('云途未返回运单号/追踪号: ' + JSON.stringify(item).slice(0, 300));
  return { waybillNumber, trackingNumber, raw: item };
}
