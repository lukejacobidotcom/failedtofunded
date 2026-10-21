import { ReportForm } from "./report-form";
function Arrow() { return <span aria-hidden="true">↗</span>; }
export default function Home() {
  return <>
    <a className="skip-link" href="#report">Skip to report form</a>
    <header className="site-header wrap">
      <a className="wordmark" href="https://failedtofunded.com/survivor" aria-label="Vest Slippage home"><span className="mark" aria-hidden="true"><i/><i/><i/></span>vest<span>slippage</span><sup>↗</sup></a>
      <nav aria-label="Main navigation"><a href="#purpose">The initiative</a><a href="#questions">Questions</a><a className="nav-cta" href="#report">Share your experience <Arrow/></a></nav>
    </header>
    <main>
      <section className="hero wrap">
        <div className="hero-copy">
          <div className="eyebrow"><span className="status-dot"/> VEST TRADER REPORTS</div>
          <h1>A bad fill.<br/>A failed account.<br/><em>A bigger picture.</em></h1>
          <p className="hero-intro">Did slippage on <strong>Vest Markets</strong> affect your evaluation, funded account, or payout?</p>
          <p className="hero-description">Your experience deserves to be heard. We’re bringing trader reports together to document the impact, seek answers, and push for change.</p>
          <div className="hero-actions"><a className="button primary" href="#report">Share your experience <Arrow/></a><a className="text-link" href="#purpose">Why we’re doing this <span aria-hidden="true">↓</span></a></div>
          <div className="hero-assurance"><span aria-hidden="true">◈</span> Private submission. You choose what to share.</div>
        </div>
        <div className="case-sheet" aria-label="The experiences this initiative is collecting">
          <div className="sheet-heading"><span>THE COST OF A FILL</span><span className="sheet-dot"/></div>
          <div className="sheet-diagram" aria-hidden="true">
            <div className="diagram-label">The price you expected</div><div className="price-line expected"><span/></div>
            <div className="slip-gap"><span className="gap-bracket"/><span>The difference<br/>can matter.</span></div>
            <div className="price-line actual"><span/></div><div className="diagram-label actual-label">The fill you received</div>
          </div>
          <p className="diagram-note">Conceptual illustration, not actual trade data.</p>
          <div className="sheet-row"><span>01</span><strong>Evaluation results</strong><span>↗</span></div>
          <div className="sheet-row"><span>02</span><strong>Funded accounts</strong><span>↗</span></div>
          <div className="sheet-row"><span>03</span><strong>Payouts &amp; profits</strong><span>↗</span></div>
          <div className="sheet-footer">ONE EXPERIENCE IS A START.<br/><b>TOGETHER, WE CAN SEE MORE.</b></div>
        </div>
      </section>
      <div className="principles"><div className="wrap"><span>Firsthand experiences</span><i>✳</i><span>Evidence over assumptions</span><i>✳</i><span>A collective call for answers</span></div></div>
      <section id="purpose" className="purpose wrap section">
        <div><div className="eyebrow">01 / THE INITIATIVE</div><h2>Individual experiences.<br/><em>Shared questions.</em></h2></div>
        <div className="purpose-body"><p className="large-copy">We’re investigating reports that slippage has been used to reduce evaluation pass rates and payouts on Vest Markets.</p><p>This initiative began with accounts provided to the organizer by traders and sources described as being at Vest. We are gathering firsthand experiences and supporting records to understand the scope and seek a response.</p><p>Each submission is a reported experience, not a verified finding. We’ll distinguish what traders report from what the records establish.</p><a className="text-link" href="#report">Help build the record <Arrow/></a></div>
      </section>
      <section className="process wrap section">
        <div className="section-top"><div className="eyebrow">02 / HOW IT WORKS</div><span>Your report is the starting point.</span></div>
        <div className="steps">
          <article><span className="step-number">01</span><h3>Tell us what happened.</h3><p>Leave your email and a few details. You can participate even if you don’t have every trade record ready.</p></article>
          <article><span className="step-number">02</span><h3>Help connect the evidence.</h3><p>The organizer may follow up for redacted fills, timestamps, or support correspondence. Nothing is posted automatically.</p></article>
          <article><span className="step-number">03</span><h3>Push for clear answers.</h3><p>The goal is to identify patterns, present supported findings, and seek transparent execution practices and appropriate remedies.</p></article>
        </div>
      </section>
      <section id="report" className="report-section">
        <div className="wrap report-layout">
          <div className="report-copy"><div className="eyebrow">03 / ADD YOUR EXPERIENCE</div><h2>Your story could<br/>help connect<br/><em>the dots.</em></h2><p>A short report is enough to start.<br/>Share only what you’re comfortable sharing.</p><ul className="privacy-points"><li>Contact details stay off the public site.</li><li>No Vest login or wallet connection.</li><li>No documents required at this stage.</li><li>A private link lets you delete your report.</li></ul><div className="independence-note"><span>ABOUT THIS INITIATIVE</span><p>Hosted by MyFundedFutures through Failed to Funded. MyFundedFutures offers competing evaluation programs. This initiative is not affiliated with or endorsed by Vest Markets.</p></div></div>
          <ReportForm/>
        </div>
      </section>
      <section id="questions" className="faq wrap section">
        <div><div className="eyebrow">04 / BEFORE YOU SHARE</div><h2>A few fair<br/><em>questions.</em></h2></div>
        <div className="faq-list">
          <details open><summary>Who should submit a report?<span>+</span></summary><p>Anyone who traded on Vest Markets and believes slippage affected an evaluation, funded account, profit, or payout. Describe what you directly experienced, including details that might explain the fill.</p></details>
          <details><summary>Do I need proof to participate?<span>+</span></summary><p>No. Start with what you remember. If you have records, keep the original files. Useful details include the instrument, order type, size, timestamp and time zone, expected price, actual fill, and any response from support.</p></details>
          <details><summary>Will my name or story be published?<span>+</span></summary><p>No submissions appear on the public site. The organizer can review your report and contact you about it. Only de-identified aggregate findings are contemplated without separate permission; publishing your name, quote, or records would require your separate agreement.</p></details>
          <details><summary>Does a bad fill prove deliberate manipulation?<span>+</span></summary><p>No. A report describes an experience. Establishing the cause requires examining the order, timing, market conditions, and platform records. The investigation will keep allegations and verified findings distinct.</p></details>
          <details><summary>Is this a claim for compensation?<span>+</span></summary><p>This is an information-gathering initiative. Submitting a report does not start legal representation or guarantee compensation, a payout, or an account reversal.</p></details>
          <details><summary>Can I withdraw my report?<span>+</span></summary><p>Yes. After submitting, save the private management link. You can use it to delete your report and contact information from the active collection. The form does not send an email, so keep that link yourself.</p></details>
        </div>
      </section>
    </main>
    <footer className="site-footer wrap"><div className="footer-top"><a className="wordmark" href="https://failedtofunded.com/survivor">vest<span>slippage</span><sup>↗</sup></a><p>Better information.<br/>A stronger collective voice.</p><div><a href="https://failedtofunded.com/survivor/privacy">Privacy &amp; data use</a><a href="https://docs.vestmarkets.com/" target="_blank" rel="noreferrer">Official Vest documentation ↗</a></div></div><div className="footer-bottom"><span>© 2026 Failed to Funded · A MyFundedFutures website</span><span>Reports are not verified findings.</span></div></footer>
  </>;
}
