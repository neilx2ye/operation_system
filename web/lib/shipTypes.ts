// 手动建单表单数据(前后端共用,仅类型与校验,不引入服务端依赖)
/** 单件重量(kg):产品已填重量用产品值,否则回退到设置页的默认值 */
export const unitKg = (weightG: number, defaultKg: number) => (weightG > 0 ? weightG / 1000 : defaultKg);

/** 按未退款商品汇总包裹重量 = Σ 数量 × 单件重量;missing = 未填重量的 SKU */
export function orderWeight(lines: { sku: string; qty: number; weightG: number; refunded: boolean }[], defaultKg: number) {
  const live = lines.filter((l) => !l.refunded);
  return {
    totalKg: Number(live.reduce((s, l) => s + l.qty * unitKg(l.weightG, defaultKg), 0).toFixed(3)),
    missing: live.filter((l) => !(l.weightG > 0)).map((l) => l.sku),
  };
}

export type ManualParcel = { englishName: string; chineseName: string; qty: number; unitPrice: number; unitWeightKg: number; sku?: string };

export type ManualOrder = {
  channelCode: string;
  currency: string;
  receiver: { name: string; phone: string; line1: string; line2: string; city: string; state: string; zip: string; country: string };
  parcels: ManualParcel[];
  syncShopify: boolean;
  notifyCustomer: boolean;
};

export function validateManual(m: ManualOrder): string | null {
  const r = m.receiver;
  if (!m.channelCode.trim()) return '请填写渠道代码';
  if (!r.name.trim()) return '请填写收件人姓名';
  if (!/^[A-Za-z]{2}$/.test(r.country.trim())) return '国家代码需为 2 位字母(如 US)';
  if (!r.line1.trim() || !r.city.trim()) return '请填写地址和城市';
  if (!r.phone.trim()) return '请填写电话';
  if (!m.parcels.length) return '至少保留一个商品';
  for (const p of m.parcels) {
    if (!p.englishName.trim()) return '商品英文品名不能为空(报关必填)';
    if (!(p.qty >= 1) || !Number.isInteger(p.qty)) return '商品数量需为正整数';
    if (!(p.unitPrice > 0)) return '申报单价必须大于 0';
    if (!(p.unitWeightKg > 0)) return '单件重量必须大于 0';
  }
  return null;
}
