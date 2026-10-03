import { TemplateDesigner } from '@/components/edm/TemplateDesigner';

// 设计器是纯客户端交互（预览 iframe、CodeMirror、素材上传），页面只负责把
// 路由参数交给组件；模板数据由设计器通过 /api/edm 自行加载。
export default async function EdmTemplateDesignerPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  return <TemplateDesigner templateId={templateId} />;
}