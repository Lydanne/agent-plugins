import {clsx, type ClassValue} from 'clsx';
import {extendTailwindMerge} from 'tailwind-merge';
const merge=extendTailwindMerge({prefix:'ocp'});
export function cn(...values:ClassValue[]){return merge(clsx(values));}
