import {defineComponent,h} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import WorkspacePool from './ui/WorkspacePool.vue';
export function mountWorkspacePool(container,options){
 if(!options.context)throw Error('工作区管理需要宿主上下文');
 const {context,...props}=options;
 return mountVueView(defineComponent({setup:()=>()=>h(WorkspacePool,props)}))(container,context);
}
