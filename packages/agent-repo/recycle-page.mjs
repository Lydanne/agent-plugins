import {defineComponent,h} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import RecycleView from './ui/RecycleView.vue';
export function mountRecycleBin(container,context,agentId,{onRestored=()=>{}}={}){
 return mountVueView(defineComponent({setup:()=>()=>h(RecycleView,{agentId,onRestored})}))(container,context);
}
