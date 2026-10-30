<script setup lang="ts">
import {DropdownMenuPortal as Portal} from 'reka-ui';
import {useOverlayTarget} from '../../host';
defineOptions({inheritAttrs:false});
const target=useOverlayTarget();
</script>
<template><Portal v-bind="$attrs" :to="target"><slot/></Portal></template>
