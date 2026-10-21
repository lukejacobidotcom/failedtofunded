"use client";
import { useRef, useState } from "react";
import { PUBLIC_HOME, INTAKE_API } from "../lib/public-config.mjs";
import { ACCOUNT_TYPES, IMPACT_TYPES } from "../lib/report-validation.mjs";

export function ReportForm() {
  const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const [receipt,setReceipt]=useState<{id:string;url:string}|null>(null); const [copied,setCopied]=useState(false);
  const credentials=useRef<{requestId:string;withdrawalToken:string}|null>(null);
  const feedback=useRef<HTMLDivElement>(null);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(busy) return;
    const form=event.currentTarget; const data=new FormData(form);
    const impacts=data.getAll("impacts");
    if(!impacts.length) { setError("Select at least one way the slippage affected you."); setTimeout(()=>feedback.current?.focus(),0); return; }
    setBusy(true); setError("");
    if(!credentials.current) credentials.current={requestId:crypto.randomUUID(),withdrawalToken:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("")};
    try {
      const response=await fetch(INTAKE_API,{method:"POST",credentials:"omit",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        ...credentials.current,email:data.get("email"),name:data.get("name")||"",accountType:data.get("accountType"),impacts,
        instrument:data.get("instrument")||"",incidentMonth:data.get("incidentMonth")||"",details:data.get("details")||"",
        evidenceAvailable:data.get("evidenceAvailable")==="on",consent:data.get("consent")==="on",website:data.get("website")||""
      })});
      const result=await response.json() as {ok?:boolean;error?:string;id:string}; if(!response.ok || !result.ok) throw new Error(result.error || "Your report has not been confirmed. Please try again.");
      setReceipt({id:result.id,url:PUBLIC_HOME+"/manage#"+credentials.current.withdrawalToken});
    } catch(e) {setError(e instanceof Error ? e.message : "Unable to connect. Please try again.");}
    finally {setBusy(false);setTimeout(()=>feedback.current?.focus(),0);}
  }
  async function copy() { if(!receipt) return; try {await navigator.clipboard.writeText(receipt.url);setCopied(true);}catch {setCopied(false);} }
  function download() { if(!receipt) return; const blob=new Blob(["Vest Slippage report receipt\n\nReport: "+receipt.id+"\nPrivate management link: "+receipt.url+"\n\nKeep this link private. Anyone with it can delete the report.\nNo confirmation email has been sent.\n"],{type:"text/plain"}); const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="vest-slippage-receipt.txt";a.click();URL.revokeObjectURL(url); }
  if(receipt) return <div className="form-card receipt" tabIndex={-1} ref={feedback} role="status"><span className="success-mark">✓</span><div className="eyebrow">REPORT RECEIVED</div><h3>Thank you for<br/>adding your voice.</h3><p>Your report is saved for the organizer to review. Your details are not public.</p><label htmlFor="management-link">Save your private management link</label><input id="management-link" readOnly value={receipt.url} onFocus={e=>e.target.select()}/><div className="receipt-actions"><button className="button primary" type="button" onClick={copy}>{copied?"Link copied":"Copy private link"}</button><button className="button secondary" type="button" onClick={download}>Save receipt</button></div><p className="field-help">Anyone with this link can delete your report. No confirmation email was sent, so save it before leaving this page.</p><p className="reference">Reference: {receipt.id}</p><a className="text-link" href={receipt.url}>Manage this report ↗</a></div>;
  return <form className="form-card" method="post" action={INTAKE_API} onSubmit={submit}>
    <div className="form-heading"><span className="eyebrow">YOUR EXPERIENCE</span><span>Private intake</span></div>
    <h3>Let’s start with you.</h3><p className="form-intro">Required fields are marked with an asterisk.</p>
    <div className="field"><label htmlFor="email">Email address <span>*</span></label><input id="email" name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" aria-describedby="email-help"/><p id="email-help" className="field-help">So the organizer can follow up about your report.</p></div>
    <div className="field"><label htmlFor="accountType">Which account stage was affected? <span>*</span></label><select id="accountType" name="accountType" required defaultValue=""><option value="" disabled>Select an account stage</option>{ACCOUNT_TYPES.map((type:string)=><option key={type}>{type}</option>)}</select></div>
    <fieldset className="impact-field"><legend>How were you affected? <span>*</span></legend><p className="field-help">Select all that apply.</p><div className="impact-options">{IMPACT_TYPES.map((type:string)=><label key={type}><input type="checkbox" name="impacts" value={type}/><span>{type}</span></label>)}</div></fieldset>
    <details className="optional-details"><summary>Add a few details <span>Optional +</span></summary><div className="optional-fields"><div className="field"><label htmlFor="name">Name or preferred name</label><input id="name" name="name" autoComplete="name" maxLength={100}/></div><div className="field-row"><div className="field"><label htmlFor="incidentMonth">When did this happen?</label><input id="incidentMonth" name="incidentMonth" type="month" max={new Date().toISOString().slice(0,7)}/></div><div className="field"><label htmlFor="instrument">Instrument / market</label><input id="instrument" name="instrument" maxLength={80} placeholder="e.g. NQ, ES, BTC"/></div></div><div className="field"><label htmlFor="details">What happened?</label><textarea id="details" name="details" rows={4} maxLength={3000} placeholder="Describe the fill and its impact. If known, include order size, time zone, expected price and actual price."/><p className="field-help">Please leave out account numbers, passwords, wallet keys, and other people’s personal information. Maximum 3,000 characters.</p></div><label className="checkbox-line"><input name="evidenceAvailable" type="checkbox"/><span>I have records I may be willing to share in a follow-up.</span></label></div></details>
    <div className="honeypot" aria-hidden="true"><label htmlFor="website">Leave this empty</label><input id="website" name="website" tabIndex={-1} autoComplete="off"/></div>
    <label className="checkbox-line consent"><input type="checkbox" name="consent" required/><span>I agree that MyFundedFutures’ Vest Slippage initiative team may store my report, use it to investigate and prepare de-identified aggregate findings, and email me about this initiative. I have read the <a href="https://failedtofunded.com/survivor/privacy" target="_blank" rel="noreferrer">privacy &amp; data-use notice</a>. <b>*</b></span></label>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={feedback}>{error}</div>}
    <button className="button primary submit-button" type="submit" disabled={busy}>{busy?"Saving your report…":"Submit my experience"}<span aria-hidden="true">↗</span></button>
    <p className="form-footnote">Your report is shared with the organizer, not published on this site.</p>
  </form>;
}
