// Workers request host plugin operations from Main. Do not inherit the
// Gateway's Feishu credentials or Gateway access token. Independent CLI
// configuration and credentials remain available under the task authorization.
// This is an environment boundary, not a filesystem/OS sandbox.
export function workerEnvironment(source=process.env) {
 return Object.fromEntries(Object.entries(source).filter(([key])=>
  !/^(?:FEISHU_(?:APP_ID|APP_SECRET|ENCRYPT_KEY|VERIFICATION_TOKEN)$|LARK_(?:APP_ID|APP_SECRET|ACCESS_TOKEN)$|OPENCLAW_GATEWAY_(?:TOKEN|PASSWORD)$)/i.test(key)));
}
