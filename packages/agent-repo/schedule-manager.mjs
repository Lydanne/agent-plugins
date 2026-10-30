import {defineComponent,h,nextTick} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import ScheduleManager from './ui/ScheduleManager.vue';
export function mountScheduleManager(container,options){
 if(!options.context)throw Error('定时任务管理需要宿主上下文');
 const {context,...props}=options;let view;
 const previous=container.ownerDocument.activeElement;
 const label=previous?.getAttribute('aria-label'),text=previous?.tagName==='BUTTON'?previous.textContent:null;
 const wrapped={...props,onClose:()=>{view?.dispose();props.onClose?.();void nextTick(()=>{if(!context.presented||!context.host.connection.canRead)return;const trigger=previous?.isConnected?previous:Array.from(container.querySelectorAll('button')).find(node=>label?node.getAttribute('aria-label')===label:text&&node.textContent===text);trigger?.focus({preventScroll:true});});}};
 view=mountVueView(defineComponent({setup:()=>()=>h(ScheduleManager,wrapped)}))(container,context);
 return view;
}
