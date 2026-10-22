import {beforeEach,expect,it,vi} from 'vitest';
import type {ClawdbotConfig} from '../runtime-api.js';
const save=vi.hoisted(()=>vi.fn());
vi.mock('./media.js',()=>({saveMessageResourceFeishu:save}));
import {resolveFeishuMediaList} from './bot-content.js';
beforeEach(()=>save.mockReset());
it('resource identity survives download path, MIME and availability changes',async()=>{
 const params={cfg:{} as ClawdbotConfig,messageId:'message',messageType:'media',content:JSON.stringify({file_key:'one',file_name:'clip.mp4'}),maxBytes:1024};
 save.mockResolvedValueOnce({saved:{path:'/tmp/first.mp4',contentType:'video/mp4'}}).mockResolvedValueOnce({saved:{path:'/tmp/second.mp4',contentType:'application/octet-stream'}}).mockRejectedValueOnce(Error('unavailable'));
 const first=await resolveFeishuMediaList(params),second=await resolveFeishuMediaList(params),failed=await resolveFeishuMediaList(params);
 expect(first[0].resourceId).toMatch(/^[a-f0-9]{64}$/);expect(second[0].resourceId).toBe(first[0].resourceId);expect(failed[0].resourceId).toBe(first[0].resourceId);expect(failed[0].path).toBeUndefined();
 save.mockResolvedValue({saved:{path:'/tmp/first.mp4',contentType:'video/mp4'}});
 const other=await resolveFeishuMediaList({...params,content:JSON.stringify({file_key:'two'})});expect(other[0].resourceId).not.toBe(first[0].resourceId);
});
it('post attachments use independent identities for image and file resources',async()=>{
 save.mockResolvedValue({saved:{path:'/tmp/resource',contentType:'application/octet-stream'}});
 const params={cfg:{} as ClawdbotConfig,messageId:'post',messageType:'post',content:JSON.stringify({zh_cn:{content:[[{tag:'img',image_key:'same'},{tag:'media',file_key:'same'}]]}}),maxBytes:1024};
 const first=await resolveFeishuMediaList(params),again=await resolveFeishuMediaList(params);
 expect(first).toHaveLength(2);expect(first[0].resourceId).not.toBe(first[1].resourceId);expect(again.map(a=>a.resourceId)).toEqual(first.map(a=>a.resourceId));
});
