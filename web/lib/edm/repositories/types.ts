import type {
  Asset,
  AudienceSnapshot,
  IntegrationsFile,
  Operation,
  Preparation,
  Template,
  TemplateCategory,
  TemplateVersion,
  TemplateVersionMeta,
} from '../types';

// 存储契约。本期只有 file 与 memory 两种实现；以后整个 OPS 接数据库时新增适配器即可，
// 页面与路由不直接引用这里，只依赖 lib/edm/service.ts。

export interface TemplateRepository {
  listTemplates(): Template[];
  getTemplate(id: string): Template | null;
  putTemplate(t: Template): void;
  deleteTemplate(id: string): void;

  listVersionMetas(templateId: string): TemplateVersionMeta[];
  getVersion(id: string): TemplateVersion | null;
  putVersion(v: TemplateVersion): void;
  countVersions(templateId: string): number;

  listCategories(): TemplateCategory[];
  putCategory(c: TemplateCategory): void;
  deleteCategory(id: string): void;
}

export interface AssetRepository {
  listAssets(): Asset[];
  getAsset(id: string): Asset | null;
  putAsset(a: Asset): void;
  deleteAsset(id: string): void;
  /** 原图二进制；文件名固定为 <id>.bin，MIME 由记录里的 mime 决定 */
  readAssetBody(id: string): Buffer | null;
  writeAssetBody(id: string, body: Buffer): void;
}

export interface AudienceRepository {
  listAudiences(): AudienceSnapshot[];
  getAudience(id: string): AudienceSnapshot | null;
  putAudience(a: AudienceSnapshot): void;
}

export interface PreparationRepository {
  listPreparations(): Preparation[];
  getPreparation(id: string): Preparation | null;
  putPreparation(p: Preparation): void;
}

export interface IntegrationRepository {
  read(): IntegrationsFile;
  write(next: IntegrationsFile): void;
}

export interface OperationRepository {
  listOperations(): Operation[];
  getOperation(id: string): Operation | null;
  putOperation(o: Operation): void;
}

export type Repositories = {
  templates: TemplateRepository;
  assets: AssetRepository;
  audiences: AudienceRepository;
  preparations: PreparationRepository;
  integrations: IntegrationRepository;
  operations: OperationRepository;
};