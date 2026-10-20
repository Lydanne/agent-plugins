import {getEntityService,type EntityObservation,type EntityValue} from './entities.mjs';
const service=getEntityService({agentId:'fixture',sessionKey:'agent:fixture:test'});
const observation:EntityObservation={typeId:'service',name:'Fixture',source:{kind:'program',namespace:'cmdb',externalId:'1'},attributes:{enabled:false,labels:['a']},observedAt:'2026-01-01T00:00:00.000Z'};
service?.upsert(observation);
service?.registerType({id:'fixture',label:'Fixture',fields:{enabled:{label:'Enabled',type:'boolean'}}});
// @ts-expect-error Programs cannot submit channel-owned identities through generic ingestion.
const channel:EntityObservation={...observation,source:{kind:'channel',namespace:'feishu',externalId:'1'}};
// @ts-expect-error Nested arbitrary JSON is not an entity attribute value.
const unsupported:EntityValue={secret:'nested'};
// @ts-expect-error Agent routing belongs to the trusted context, not the query payload.
service?.list({agentId:'other'});
void channel;void unsupported;
