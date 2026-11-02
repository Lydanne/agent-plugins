import {expect,test} from 'vitest';
import {KnowledgeSnapshotCache} from './knowledge-snapshot-cache';
const data=(count=1)=>({nodes:Array.from({length:count},(_,i)=>({path:i+'.md',title:String(i)})),edges:[]});
test('recent immutable snapshots reuse arrays and evict the least recently used frame',()=>{const c=new KnowledgeSnapshotCache(2,10),a=data(),b=data();c.set('a',a);c.set('b',b);expect(c.get('a')).toBe(a);c.set('c',data());expect(c.get('b')).toBeUndefined();expect(c.get('a')).toBe(a);});
test('the total item budget is bounded and oversized frames never get truncated',()=>{const c=new KnowledgeSnapshotCache(3,5);c.set('a',data(3));c.set('b',data(3));expect(c.get('a')).toBeUndefined();expect(c.get('b')?.nodes).toHaveLength(3);c.set('huge',data(6));expect(c.get('huge')).toBeUndefined();expect(c.get('b')?.nodes).toHaveLength(3);c.clear();expect(c.get('b')).toBeUndefined();});
