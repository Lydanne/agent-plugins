import {defineComponent,h,ref} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import ProjectsView from './ui/ProjectsView.vue';
import ManagementView from './ui/ManagementView.vue';
import {mountPeoplePage} from './people-page.mjs';
import {mountEntitiesPage} from './entities-page.mjs';
import '@openclaw-plugins/control-ui-kit/theme.css';
import './control-ui.css';
// Explicit public update keeps the legacy rescan behavior; host notifications only
// refresh reactive scope/permission snapshots and preserve in-progress browsing.
function mountRefreshing(component,options){return (container,context)=>{
 const instance=ref();
 const view=mountVueView(defineComponent({setup:()=>()=>h(component,{ref:instance})}),options)(container,context);
 return {...view,update(next){view.update?.(next);instance.value?.refreshFromUpdate?.();}};
};}
export const mountProjects=mountRefreshing(ProjectsView,{density:'sidebar'});
export const mountAgentRepo=mountRefreshing(ManagementView);
export {mountPeoplePage};
export default {id:'agent-repo',activate(host){
 const panel=host.ui.registerPanel({id:'projects',label:'项目、技能与子代理',mount:mountProjects});
 const people=host.ui.registerPage({id:'people',label:'飞书人员管理',mount:mountPeoplePage});
 const entities=host.ui.registerPage({id:'entities',label:'实体资料库',mount:mountEntitiesPage});
 const management=host.ui.registerPage({id:'management',label:'AgentRepo',mount:mountAgentRepo});
 const navigation=host.ui.registerNavigation({id:'agent-repo',label:'AgentRepo',page:{id:'management'},icon:'folder',order:60,defaultVisible:true});
 return ()=>{navigation();management();entities();people();panel();};
}};
