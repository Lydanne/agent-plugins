import {defineComponent,h,ref,nextTick} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import SkillMaintenance from './ui/SkillMaintenance.vue';
export function mountSkillMaintenance(container,context,agentId,options={}){
 const sources=ref(options.sources??[]),scopeKey=ref(options.scopeKey??''),component=ref();
 let focused=null,selection=null;
 const element=container.ownerDocument.createElement('div');container.append(element);
 const view=mountVueView(defineComponent({setup:()=>()=>h(SkillMaintenance,{ref:component,agentId,sources:sources.value,scopeKey:scopeKey.value,onView:options.onViewChange,onQuery:options.onQuery})}))(element,context);
 return {...view,element,get view(){return component.value?.view??'skills';},refresh:()=>component.value?.refresh(),rememberFocus(){const active=element.ownerDocument.activeElement;if(element.contains(active)){focused=active;selection=active instanceof HTMLInputElement?[active.selectionStart,active.selectionEnd]:null;}},setSources(next,key){sources.value=next;scopeKey.value=key;void nextTick(()=>{if(focused?.isConnected){focused.focus({preventScroll:true});if(selection)focused.setSelectionRange(...selection);}focused=null;});},dispose(){view.dispose();element.remove();}};
}
