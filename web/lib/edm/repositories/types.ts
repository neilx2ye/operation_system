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

// 存储契约。实现有 postgres / file / memory 三种；页面与路由不直接引用这里，
// 只依赖 lib/edm/service.ts，因此更换存储后端不影响上层。
//
// 全部方法返回 Promise：数据库访问天然异步，文件与内存实现也统一成异步，
// 保证三种后端对上层暴露完全相同的调用形态。

export interface TemplateRepository {
  listTemplates(): Promise<Template[]>;
  getTemplate(id: string): Promise<Template | null>;
  putTemplate(t: Template): Promise<void>;
  /** 删除模板，并连同它名下的所有版本一起清理 */
  deleteTemplate(id: string): Promise<void>;

  listVersionMetas(templateId: string): Promise<TemplateVersionMeta[]>;
  getVersion(id: string): Promise<TemplateVersion | null>;
  putVersion(v: TemplateVersion): Promise<void>;
  countVersions(templateId: string): Promise<number>;

  listCategories(): Promise<TemplateCategory[]>;
  putCategory(c: TemplateCategory): Promise<void>;
  deleteCategory(id: string): Promise<void>;
}

export interface AssetRepository {
  listAssets(): Promise<Asset[]>;
  getAsset(id: string): Promise<Asset | null>;
  putAsset(a: Asset): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  /** 原图二进制；文件名固定为 <id>.bin，MIME 由记录里的 mime 决定 */
  readAssetBody(id: string): Promise<Buffer | null>;
  writeAssetBody(id: string, body: Buffer): Promise<void>;
}

export interface AudienceRepository {
  listAudiences(): Promise<AudienceSnapshot[]>;
  getAudience(id: string): Promise<AudienceSnapshot | null>;
  putAudience(a: AudienceSnapshot): Promise<void>;
  deleteAudience(id: string): Promise<void>;
}

export interface PreparationRepository {
  listPreparations(): Promise<Preparation[]>;
  getPreparation(id: string): Promise<Preparation | null>;
  putPreparation(p: Preparation): Promise<void>;
}

export interface IntegrationRepository {
  read(): Promise<IntegrationsFile>;
  write(next: IntegrationsFile): Promise<void>;
}

export interface OperationRepository {
  listOperations(): Promise<Operation[]>;
  getOperation(id: string): Promise<Operation | null>;
  putOperation(o: Operation): Promise<void>;
}

export type Repositories = {
  templates: TemplateRepository;
  assets: AssetRepository;
  audiences: AudienceRepository;
  preparations: PreparationRepository;
  integrations: IntegrationRepository;
  operations: OperationRepository;
};
