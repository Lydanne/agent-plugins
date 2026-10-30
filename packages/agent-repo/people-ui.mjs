import {defineComponent,h,ref} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import PeopleDialog from './ui/PeopleDialog.vue';
export function mountPeopleDialog(parent,options){
 if(!options.context)throw Error('人员管理需要宿主上下文');
 const component=ref();let view;
 const wrapped={...options,onClose:()=>{view?.dispose();options.onClose?.();}};
 const mount=mountVueView(defineComponent({setup:()=>()=>h(PeopleDialog,{ref:component,options:wrapped})}));
 view=mount(parent,options.context);
 return {...view,refresh:()=>component.value?.refresh()};
}
