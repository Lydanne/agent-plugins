<script setup lang="ts">
import {computed} from 'vue';
const props=defineProps<{text:string;needle:string}>();
const pieces=computed(()=>{const value=props.text,needle=props.needle.toLocaleLowerCase();if(!needle)return [{text:value,marked:false}];const pieces:{text:string;marked:boolean}[]=[];let from=0,index:number;while((index=value.toLocaleLowerCase().indexOf(needle,from))>=0){pieces.push({text:value.slice(from,index),marked:false},{text:value.slice(index,index+props.needle.length),marked:true});from=index+props.needle.length;}pieces.push({text:value.slice(from),marked:false});return pieces;});
</script>
<template><template v-for="(piece,index) in pieces" :key="index"><mark v-if="piece.marked">{{piece.text}}</mark><template v-else>{{piece.text}}</template></template></template>
