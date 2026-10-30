import {defineComponent,h} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import '@openclaw-plugins/control-ui-kit/theme.css';
import './control-ui.css';
import WorkerPanel from './ui/WorkerPanel.vue';
import {registerWorkerNavigation} from './dist/ui-navigation.mjs';
export const mountPanel=mountVueView(WorkerPanel,{density:'sidebar'});
export const mountProjectPage=mountVueView(defineComponent({setup:()=>()=>h(WorkerPanel,{projectPage:true})}),{density:'sidebar'});
export default {id:'agent-worker',activate(host){
 const panel=host.ui.registerPanel({id:'agent-worker-sessions',label:'Agent Worker 会话',mount:mountPanel});
 const page=host.ui.registerPage({id:'project-tasks',label:'Worker 项目任务',mount:mountProjectPage});
 const navigation=registerWorkerNavigation(params=>host.navigation.openPage({id:'project-tasks',params}));
 return ()=>{navigation();page();panel();};
}};
