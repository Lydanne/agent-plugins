import {it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import {defineComponent,ref,nextTick} from 'vue';
import {SearchField,EmptyState,StatusNotice,PageHeader,Button,cn} from '../src';
it('searches explicitly, trims query, clears with focus restored and preserves the native disabled boundary',async()=>{
 const searches:string[]=[];
 const wrapper=mount(defineComponent({components:{SearchField},setup(){return {query:ref(''),search:(value:string)=>searches.push(value),busy:ref(false),disabled:ref(false)};},template:'<SearchField v-model="query" aria-label="搜索知识库" :busy="busy" :disabled="disabled" @search="search" />'}),{attachTo:document.body});
 try{
  const input=wrapper.get('input');expect(input.attributes('aria-label')).toBe('搜索知识库');expect(wrapper.get('label').attributes('for')).toBe(input.attributes('id'));
  await input.setValue('  知识 报告  ');expect(searches).toEqual([]);await wrapper.get('form').trigger('submit');expect(searches).toEqual(['知识 报告']);
  await wrapper.get('[aria-label="清空搜索"]').trigger('click');await nextTick();expect((input.element as HTMLInputElement).value).toBe('');expect(searches).toEqual(['知识 报告','']);expect(document.activeElement).toBe(input.element);
  await input.setValue('草稿');wrapper.vm.busy=true;await nextTick();await wrapper.get('form').trigger('submit');expect(searches).toHaveLength(2);expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined();
  wrapper.vm.busy=false;wrapper.vm.disabled=true;await nextTick();await input.trigger('keydown',{key:'Escape'});expect(searches).toHaveLength(2);expect(input.attributes('disabled')).toBeDefined();expect((input.element as HTMLInputElement).value).toBe('草稿');
 }finally{wrapper.unmount();}
});
it('does not submit during Chinese composition and supports Escape to reset a completed query',async()=>{
 const wrapper=mount(SearchField,{props:{modelValue:'报告'}});
 try{await wrapper.get('input').trigger('compositionstart');await wrapper.get('form').trigger('submit');expect(wrapper.emitted('search')).toBeUndefined();await wrapper.get('input').trigger('compositionend');await wrapper.get('form').trigger('submit');expect(wrapper.emitted('search')).toEqual([['报告']]);await wrapper.get('input').trigger('keydown',{key:'Escape'});expect(wrapper.emitted('search')).toEqual([['报告'],['']]);expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['']);}finally{wrapper.unmount();}
});
it('shared compositions retain shadcn slots and expose accessible escaped states',()=>{
 const empty=mount(EmptyState,{props:{title:'<script>标题</script>',description:'选择一个条目'},slots:{default:'操作'}}),notice=mount(StatusNotice,{props:{tone:'error',title:'读取失败'},slots:{default:()=>'<secret>'}}),header=mount(PageHeader,{props:{title:'知识库',description:'项目知识'},slots:{default:'刷新'}}),button=mount(Button,{slots:{default:'提交'}});
 try{expect(empty.get('[data-slot=empty-title]').text()).toBe('<script>标题</script>');expect(empty.find('script').exists()).toBe(false);expect(empty.attributes('role')).toBe('status');expect(notice.attributes('role')).toBe('alert');expect(notice.get('[data-slot=alert-description]').text()).toBe('<secret>');expect(header.get('h2').text()).toBe('知识库');expect(header.get('[data-slot=page-actions]').text()).toBe('刷新');expect(button.attributes('data-variant')).toBe('default');expect(button.attributes('type')).toBe('button');expect(cn('ocp:px-2','ocp:px-4')).toBe('ocp:px-4');}finally{for(const view of [empty,notice,header,button])view.unmount();}
});

it('textarea submits the latest controlled draft and keeps readonly source bytes as text',async()=>{
 const {Textarea}=await import('../src');let saved='';
 const wrapper=mount(defineComponent({components:{Textarea},setup(){const draft=ref('原始');return {draft,save:()=>{saved=draft.value;}};},template:'<form @submit.prevent="save"><Textarea v-model="draft" required maxlength="4000" rows="8" aria-label="任务正文" /></form>'}));
 try{const input=wrapper.get('textarea').element as HTMLTextAreaElement;input.value='修改后的任务';input.dispatchEvent(new Event('input',{bubbles:true}));wrapper.get('form').element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(saved).toBe('修改后的任务');expect(input.required).toBe(true);expect(input.maxLength).toBe(4000);expect(input.getAttribute('rows')).toBe('8');await nextTick();}finally{wrapper.unmount();}
 const source=mount(Textarea,{props:{modelValue:'<script>原始 JSON</script>'},attrs:{readonly:true}});try{expect((source.element as HTMLTextAreaElement).value).toBe('<script>原始 JSON</script>');expect((source.element as HTMLTextAreaElement).readOnly).toBe(true);expect(source.find('script').exists()).toBe(false);}finally{source.unmount();}
});
it('page header preserves semantic heading level and programmatic detail focus',()=>{
 const header=mount(PageHeader,{props:{title:'技能详情',heading:'h3',compact:true},attachTo:document.body});try{header.vm.focus({preventScroll:true});expect(document.activeElement).toBe(header.get('h3').element);expect(header.find('h2').exists()).toBe(false);}finally{header.unmount();}
});
it('controlled mixed checkbox exposes partial selection and activates to checked once',async()=>{
 const {Checkbox}=await import('../src');const wrapper=mount(Checkbox,{props:{modelValue:'indeterminate'},attrs:{'aria-label':'全选'}});try{expect(wrapper.get('[role=checkbox]').attributes('aria-checked')).toBe('mixed');expect(wrapper.find('[data-slot=checkbox-mixed-icon]').exists()).toBe(true);await wrapper.get('[role=checkbox]').trigger('click');expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);await wrapper.setProps({modelValue:true});expect(wrapper.get('[role=checkbox]').attributes('aria-checked')).toBe('true');expect(wrapper.find('[data-slot=checkbox-mixed-icon]').exists()).toBe(false);}finally{wrapper.unmount();}
});
