import {defineComponent,h} from 'vue';
function icon(name:string,paths:string[]){return defineComponent({name,setup:()=>()=>h('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:'0 0 24 24',width:24,height:24,fill:'none',stroke:'currentColor','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'},paths.map(d=>h('path',{d})))});}
export const Check=icon('Check',['m4 12 5 5L20 6']);
export const ChevronDown=icon('ChevronDown',['m6 9 6 6 6-6']);
export const ChevronUp=icon('ChevronUp',['m6 15 6-6 6 6']);
export const ChevronLeftIcon=icon('ChevronLeft',['m15 6-6 6 6 6']);
export const ChevronRight=icon('ChevronRight',['m9 6 6 6-6 6']);
export const ChevronRightIcon=ChevronRight;
export const X=icon('Close',['M6 6l12 12M18 6 6 18']);
export const Circle=defineComponent({name:'Circle',setup:()=>()=>h('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:'0 0 24 24',width:24,height:24,fill:'currentColor','aria-hidden':'true'},[h('circle',{cx:12,cy:12,r:5})])});
export const MoreHorizontal=defineComponent({name:'MoreHorizontal',setup:()=>()=>h('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:'0 0 24 24',width:24,height:24,fill:'currentColor','aria-hidden':'true'},[6,12,18].map(cx=>h('circle',{cx,cy:12,r:1.5})))});
