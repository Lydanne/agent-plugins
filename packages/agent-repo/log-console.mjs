import {defineComponent,h,ref} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import LogConsole from './ui/LogConsole.vue';
export function mountLogConsole(container,options){
 if(!options.context)throw Error('日志控制台需要宿主上下文');
 const {context,...props}=options,component=ref();
 const view=mountVueView(defineComponent({setup:()=>()=>h(LogConsole,{ref:component,...props})}))(container,context);
 return {...view,refresh:()=>component.value?.refresh()};
}
