import {defineComponent,h} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import WorkerTasks from './ui/WorkerTasks.vue';
export function mountWorkerPage(container,context,agentId){
 return mountVueView(defineComponent({setup:()=>()=>h(WorkerTasks,{agentId})}))(container,context);
}
