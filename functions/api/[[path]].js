const VERSION='hammy-garden-v3';const LEVEL_GEMS=[9,10,10,10,11,11,12,12,12,13,13,14,14,14,14,14,15,15,16,20];const validVersion=v=>v===VERSION||v==='hammy-pocket-v2';
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
let schemaDB=null,schemaPromise=null;
async function ensureSchema(db){if(schemaDB!==db){schemaDB=db;schemaPromise=null}if(!schemaPromise)schemaPromise=db.batch([
 db.prepare('CREATE TABLE IF NOT EXISTS runs (token TEXT PRIMARY KEY, player TEXT NOT NULL, name TEXT NOT NULL, level INTEGER NOT NULL, version TEXT NOT NULL, started INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, ip_hash TEXT NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS scores (player TEXT NOT NULL, name TEXT NOT NULL, level INTEGER NOT NULL, version TEXT NOT NULL, time_ms INTEGER NOT NULL, crystals INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(player,level,version))'),
 db.prepare('CREATE INDEX IF NOT EXISTS scores_ranking ON scores(version,level,time_ms ASC,crystals DESC,created ASC)'),
 db.prepare('CREATE INDEX IF NOT EXISTS runs_rate ON runs(ip_hash,started)')
 ]).catch(e=>{schemaPromise=null;throw e});return schemaPromise}
async function digest(text){const buffer=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,'0')).join('')}
function cookie(request){const match=(request.headers.get('Cookie')||'').match(/(?:^|;\s*)hammy_player=([a-f0-9-]{36})(?:;|$)/);return match?.[1]||crypto.randomUUID()}
function validLevel(n){return Number.isInteger(n)&&n>=1&&n<=20}
async function body(request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('Please send JSON data');const t=await request.text();if(t.length>4096)throw Error('Request is too long');return JSON.parse(t)}
export async function onRequest({request,env}){
 const url=new URL(request.url),path=url.pathname.replace(/\/$/,'');if(!env.DB)return json({error:'The leaderboard database is not connected',setupRequired:true},503);
 try{await ensureSchema(env.DB);
 if(request.method==='GET'&&path==='/api/leaderboard'){
 const level=Number(url.searchParams.get('level')),version=url.searchParams.get('version');if(!validLevel(level)||!validVersion(version))return json({error:'Invalid level or game version'},400);
 const data=await env.DB.prepare('SELECT name,time_ms,crystals FROM scores WHERE level=? AND version=? ORDER BY time_ms ASC, crystals DESC, created ASC LIMIT 50').bind(level,version).all();return json({entries:data.results||[],level,version});}
 if(request.method!=='POST'||!['/api/run','/api/score'].includes(path))return json({error:'API not found'},404);
 if(request.headers.get('Origin')!==url.origin)return json({error:'Request origin is not allowed'},403);
 const input=await body(request),player=cookie(request),now=Date.now();
 if(!validLevel(input.level)||!validVersion(input.version))return json({error:'Invalid level or game version'},400);
 if(path==='/api/run'){
 const name=typeof input.name==='string'?input.name.trim().normalize('NFC'):'';if(name.length<1||name.length>20||/[\u0000-\u001f<>]/.test(name))return json({error:'Player names must contain 1-20 characters'},400);
 const ipHash=await digest((request.headers.get('CF-Connecting-IP')||player)+':'+new Date(now).toISOString().slice(0,10));
 const rate=await env.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE ip_hash=? AND started>?').bind(ipHash,now-60000).first();if(rate.count>=30)return json({error:'Too many runs. Please wait a moment'},429);
 const token=crypto.randomUUID()+crypto.randomUUID();await env.DB.batch([env.DB.prepare('DELETE FROM runs WHERE started<?').bind(now-86400000),env.DB.prepare('INSERT INTO runs(token,player,name,level,version,started,ip_hash) VALUES(?,?,?,?,?,?,?)').bind(await digest(token),player,name,input.level,input.version,now,ipHash)]);
 return json({token,started:now},201,{'Set-Cookie':`hammy_player=${player}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`});}
 const maxGems=input.version===VERSION?LEVEL_GEMS[input.level-1]:8+Math.floor(input.level*.5),minimum=Math.floor(maxGems*8/18*600);
 if(typeof input.token!=='string'||input.token.length>100||!Number.isInteger(input.time_ms)||input.time_ms<minimum||input.time_ms>3600000||!Number.isInteger(input.crystals)||input.crystals<0||input.crystals>maxGems)return json({error:'Score validation failed'},400);
 const token=await digest(input.token);const run=await env.DB.prepare('SELECT * FROM runs WHERE token=? AND player=? AND level=? AND version=?').bind(token,player,input.level,input.version).first();if(!run||now-run.started>3600000||input.time_ms>now-run.started+1500)return json({error:'Run expired, already used, or timing does not match'},400);
 // Claim the run and publish in one atomic D1 batch. The score insert is conditional
 // on this request's unique claim timestamp, so concurrent replays cannot submit twice.
 if(run.used!==0)return json({saved:true,alreadySubmitted:true});
 const claim=crypto.randomUUID();const results=await env.DB.batch([
 env.DB.prepare('UPDATE runs SET used=? WHERE token=? AND used=0').bind(claim,token),
 env.DB.prepare(`INSERT INTO scores(player,name,level,version,time_ms,crystals,created)
 SELECT player,name,level,version,?,?,? FROM runs WHERE token=? AND used=?
 ON CONFLICT(player,level,version) DO UPDATE SET name=excluded.name,time_ms=excluded.time_ms,crystals=excluded.crystals,created=excluded.created
 WHERE excluded.time_ms<scores.time_ms OR (excluded.time_ms=scores.time_ms AND excluded.crystals>scores.crystals)`).bind(input.time_ms,input.crystals,now,token,claim)
 ]);if(!results[0].meta?.changes)return json({saved:true,alreadySubmitted:true});return json({saved:true});
 }catch(e){console.error('Leaderboard request failed:',e.message);return json({error:e instanceof SyntaxError?'Invalid JSON':'Could not save or load scores right now'},e instanceof SyntaxError?400:500)}
}
