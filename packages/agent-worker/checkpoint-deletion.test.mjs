import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDeletionState} from './session-deletion.mjs';
test('a parked checkpoint blocks session deletion even though pool capacity is free',()=>{
 const job={jobId:'job',status:'completed',useWorkspace:true,workspaceSettled:true,workspaceRelease:'idle'};
 assert.equal(sessionDeletionState({},[job]).canDelete,true);
 const parked={...job,workspaceCheckpoint:{checkpointId:'first',jobId:'job'}};
 assert.equal(sessionDeletionState({},[parked]).canDelete,false);
 assert.match(sessionDeletionState({},[parked]).deleteReason,/workspace/);
 assert.notEqual(sessionDeletionState({},[parked]).deletionRevision,sessionDeletionState({},[{...parked,workspaceCheckpoint:{...parked.workspaceCheckpoint,checkpointId:'second'}}]).deletionRevision);
});
