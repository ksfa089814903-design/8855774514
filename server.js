import express from "express";
import Database from "better-sqlite3";
import cookieSession from "cookie-session";
import QRCode from "qrcode";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";
dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dbFile=process.env.DB_FILE||path.join(__dirname,"data","activity.sqlite");
fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const db=new Database(dbFile);
db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON");
db.exec(`CREATE TABLE IF NOT EXISTS events(
 id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT DEFAULT '',
 event_date TEXT NOT NULL,start_time TEXT NOT NULL,end_time TEXT NOT NULL,location TEXT DEFAULT '',
 capacity INTEGER NOT NULL,fee INTEGER DEFAULT 0,registration_start TEXT DEFAULT '',registration_end TEXT DEFAULT '',
 status TEXT DEFAULT 'published',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS registrations(
 id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,registration_no TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT DEFAULT '',people INTEGER NOT NULL,note TEXT DEFAULT '',
 status TEXT DEFAULT 'confirmed',created_at TEXT DEFAULT CURRENT_TIMESTAMP,checked_in_at TEXT,
 FOREIGN KEY(event_id) REFERENCES events(id));
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"100kb"}));
app.use(cookieSession({name:"session",keys:[process.env.SESSION_SECRET||"dev-only-change-me"],httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}));
const admin=(req,res,next)=>req.session?.admin?next():res.status(401).json({error:"未登入"});
const audit=(a,d)=>db.prepare("INSERT INTO audit_logs(action,detail) VALUES(?,?)").run(a,JSON.stringify(d||{}));
const seats=id=>{const e=db.prepare("SELECT capacity FROM events WHERE id=?").get(id);const used=db.prepare("SELECT COALESCE(SUM(people),0) n FROM registrations WHERE event_id=? AND status IN ('confirmed','checked_in')").get(id)?.n||0;return {capacity:e?.capacity||0,used,remaining:Math.max(0,(e?.capacity||0)-used)}};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const no=()=>`ACT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
if(db.prepare("SELECT COUNT(*) c FROM events").get().c===0){const q=db.prepare(`INSERT INTO events(title,description,event_date,start_time,end_time,location,capacity,fee,status) VALUES(?,?,?,?,?,?,?,?,?)`);q.run("2026 秋季親子自然體驗活動","親子一起認識農村生態與自然環境。","2026-10-17","09:00","12:00","休閒中心",30,0,"published");q.run("農村 DIY 手作體驗","實作在地農村手作課程。","2026-10-24","09:30","11:30","活動教室",25,200,"published");q.run("樂齡健康生活講座","生活保健與健康生活講座。","2026-11-07","14:00","16:00","多功能教室",50,0,"published");}
app.get("/health",(req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.get("/api/events",(req,res)=>res.json(db.prepare("SELECT * FROM events WHERE status='published' ORDER BY event_date,start_time").all().map(e=>({...e,...seats(e.id)}))));
app.get("/api/events/:id",(req,res)=>{const e=db.prepare("SELECT * FROM events WHERE id=? AND status='published'").get(req.params.id);if(!e)return res.status(404).json({error:"活動不存在"});res.json({...e,...seats(e.id)})});
app.post("/api/events/:id/register",(req,res)=>{
 const {name,phone,email="",people=1,note=""}=req.body||{}; const p=Number(people);
 if(!String(name||"").trim()||!String(phone||"").trim())return res.status(400).json({error:"姓名與手機為必填"});
 if(!Number.isInteger(p)||p<1||p>20)return res.status(400).json({error:"人數須為1–20"});
 const e=db.prepare("SELECT * FROM events WHERE id=? AND status='published'").get(req.params.id);if(!e)return res.status(404).json({error:"活動不存在"});
 if(e.registration_start&&new Date()<new Date(e.registration_start))return res.status(409).json({error:"尚未開放報名"});
 if(e.registration_end&&new Date()>new Date(e.registration_end))return res.status(409).json({error:"報名已截止"});
 try{
  const out=db.transaction(()=>{const s=seats(e.id);if(p>s.remaining)throw new Error(`名額不足，目前剩餘 ${s.remaining} 名`);
   let n;do{n=no()}while(db.prepare("SELECT 1 FROM registrations WHERE registration_no=?").get(n));
   db.prepare("INSERT INTO registrations(event_id,registration_no,name,phone,email,people,note) VALUES(?,?,?,?,?,?,?)").run(e.id,n,String(name).trim(),String(phone).trim(),String(email).trim(),p,String(note).trim());
   audit("register",{registration_no:n,event_id:e.id,people:p});return n;})();res.status(201).json({registration_no:out,event:e.title,people:p});
 }catch(x){res.status(409).json({error:x.message})}
});
app.post("/api/registration/search",(req,res)=>{const r=db.prepare(`SELECT r.*,e.title,e.event_date,e.start_time,e.end_time,e.location,e.fee FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.registration_no=? AND r.phone=?`).get(String(req.body?.registration_no||"").trim(),String(req.body?.phone||"").trim());if(!r)return res.status(404).json({error:"查無資料"});res.json(r)});
app.get("/api/registration/:no/qr",async(req,res)=>{const r=db.prepare("SELECT registration_no FROM registrations WHERE registration_no=?").get(req.params.no);if(!r)return res.status(404).end();res.type("png").send(await QRCode.toBuffer(`${process.env.PUBLIC_BASE_URL||"http://localhost:3000"}/checkin?code=${r.registration_no}`,{width:420,margin:2}))});
app.post("/api/admin/login",(req,res)=>{if(req.body?.username===process.env.ADMIN_USER&&req.body?.password===process.env.ADMIN_PASSWORD){req.session.admin=true;audit("admin_login",{user:req.body.username});return res.json({ok:true})}res.status(401).json({error:"帳號或密碼錯誤"})});
app.post("/api/admin/logout",(req,res)=>{req.session=null;res.json({ok:true})});
app.get("/api/admin/me",admin,(req,res)=>res.json({ok:true}));
app.get("/api/admin/dashboard",admin,(req,res)=>{const events=db.prepare("SELECT COUNT(*) n FROM events").get().n;const regs=db.prepare("SELECT COUNT(*) n FROM registrations WHERE status!='cancelled'").get().n;const people=db.prepare("SELECT COALESCE(SUM(people),0) n FROM registrations WHERE status!='cancelled'").get().n;const checked=db.prepare("SELECT COUNT(*) n FROM registrations WHERE status='checked_in'").get().n;res.json({events,registrations:regs,people,checked_in:checked})});
app.get("/api/admin/events",admin,(req,res)=>res.json(db.prepare("SELECT * FROM events ORDER BY event_date DESC,start_time").all().map(e=>({...e,...seats(e.id)}))));
app.post("/api/admin/events",admin,(req,res)=>{const x=req.body||{};if(!x.title||!x.event_date||!x.start_time||!x.end_time||!Number(x.capacity))return res.status(400).json({error:"活動名稱、日期、時間、名額必填"});const r=db.prepare(`INSERT INTO events(title,description,event_date,start_time,end_time,location,capacity,fee,registration_start,registration_end,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(x.title,x.description||"",x.event_date,x.start_time,x.end_time,x.location||"",Number(x.capacity),Number(x.fee||0),x.registration_start||"",x.registration_end||"",x.status||"published");audit("event_create",{id:r.lastInsertRowid});res.json({id:r.lastInsertRowid})});
app.patch("/api/admin/events/:id",admin,(req,res)=>{const o=db.prepare("SELECT * FROM events WHERE id=?").get(req.params.id);if(!o)return res.status(404).json({error:"活動不存在"});const v={...o,...req.body};if(Number(v.capacity)<seats(o.id).used)return res.status(409).json({error:"名額不可低於目前已報名人數"});db.prepare(`UPDATE events SET title=?,description=?,event_date=?,start_time=?,end_time=?,location=?,capacity=?,fee=?,registration_start=?,registration_end=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(v.title,v.description,v.event_date,v.start_time,v.end_time,v.location,Number(v.capacity),Number(v.fee||0),v.registration_start||"",v.registration_end||"",v.status,v.id);audit("event_update",{id:v.id});res.json({ok:true})});
app.get("/api/admin/events/:id/registrations",admin,(req,res)=>res.json(db.prepare("SELECT * FROM registrations WHERE event_id=? ORDER BY created_at DESC").all(req.params.id)));
app.patch("/api/admin/registrations/:id",admin,(req,res)=>{const s=req.body?.status;if(!["confirmed","cancelled","checked_in"].includes(s))return res.status(400).json({error:"狀態錯誤"});const r=db.prepare("SELECT * FROM registrations WHERE id=?").get(req.params.id);if(!r)return res.status(404).json({error:"報名不存在"});db.prepare("UPDATE registrations SET status=?,checked_in_at=? WHERE id=?").run(s,s==="checked_in"?new Date().toISOString():r.checked_in_at,r.id);audit("registration_status",{id:r.id,status:s});res.json({ok:true})});
app.post("/api/admin/checkin",admin,(req,res)=>{const r=db.prepare("SELECT * FROM registrations WHERE registration_no=?").get(String(req.body?.registration_no||"").trim());if(!r)return res.status(404).json({error:"找不到報名編號"});if(r.status==="cancelled")return res.status(409).json({error:"此報名已取消"});db.prepare("UPDATE registrations SET status='checked_in',checked_in_at=? WHERE id=?").run(new Date().toISOString(),r.id);audit("checkin",{id:r.id});res.json({ok:true,name:r.name,registration_no:r.registration_no})});
app.get("/api/admin/events/:id/export.csv",admin,(req,res)=>{const rows=db.prepare(`SELECT registration_no AS 報名編號,name AS 姓名,phone AS 手機,email AS Email,people AS 人數,note AS 備註,status AS 狀態,created_at AS 報名時間,checked_in_at AS 報到時間 FROM registrations WHERE event_id=? ORDER BY created_at`).all(req.params.id);const c=["報名編號","姓名","手機","Email","人數","備註","狀態","報名時間","報到時間"];const q=v=>`"${String(v??"").replaceAll('"','""')}"`;res.setHeader("Content-Type","text/csv;charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="registrations-${req.params.id}.csv"`);res.send("\ufeff"+c.join(",")+"\n"+rows.map(r=>c.map(k=>q(r[k])).join(",")).join("\n"))});
app.use(express.static(path.join(__dirname,"public")));app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.listen(Number(process.env.PORT||3000),"0.0.0.0",()=>console.log("server started"));
