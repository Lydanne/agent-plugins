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
