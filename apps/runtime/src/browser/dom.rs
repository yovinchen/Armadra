//! The fixed page-side helpers.
//!
//! Design §7: "浏览器 Worker 可内部执行固定的 DOM 辅助脚本，调用者不能注入代码."
//! Everything a caller supplies — a selector, a piece of text — enters these
//! scripts only as a JSON string literal produced by [`quote`], never as
//! source. There is no code path that evaluates caller-provided JavaScript.

/// A caller value as a JavaScript string literal. `serde_json` escapes quotes,
/// backslashes, control characters and line separators, so the result cannot
/// terminate the literal it sits in.
pub fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Visible text of the document, which is what "read the page" means to an
/// agent. `innerText` rather than `textContent`: script and style bodies are
/// not prose, and neither is a `display:none` subtree.
pub const PAGE_TEXT: &str =
    "(()=>{const b=document.body;return b?b.innerText:document.documentElement.textContent||''})()";

pub const TITLE: &str = "document.title";
pub const LOCATION: &str = "location.href";

/// Centre point and visibility of the first match, or `null`.
pub fn rect_of(selector: &str) -> String {
    format!(
        "(()=>{{const e=document.querySelector({});if(!e)return null;\
         const r=e.getBoundingClientRect();\
         return {{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,\
         visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'}}}})()",
        quote(selector)
    )
}

/// True when the selector matches something. Used by `wait`.
pub fn exists(selector: &str) -> String {
    format!("!!document.querySelector({})", quote(selector))
}

/// Focuses a field and optionally empties it, reporting whether it found one.
///
/// Clearing goes through the element's own value setter plus an `input` event
/// so frameworks that mirror the DOM see the change; a silent `value = ''`
/// leaves React thinking the old text is still there.
pub fn focus_field(selector: &str, replace: bool) -> String {
    format!(
        "(()=>{{const e=document.querySelector({});if(!e)return false;e.focus();\
         if({} && ('value' in e)){{const p=Object.getPrototypeOf(e);\
         const d=Object.getOwnPropertyDescriptor(p,'value');\
         if(d&&d.set)d.set.call(e,'');else e.value='';\
         e.dispatchEvent(new Event('input',{{bubbles:true}}));}}\
         else if({} && e.isContentEditable){{e.textContent='';}}\
         return true}})()",
        quote(selector),
        replace,
        replace
    )
}

/// Interactive elements with a stable-per-document index.
///
/// The index is what the caller gets back as an element reference; it is only
/// meaningful for the navigation epoch it was produced in, which is why the
/// session refuses a reference minted before the last navigation.
pub fn elements(limit: usize) -> String {
    format!(
        "(()=>{{const out=[];const seen=document.querySelectorAll(\
         'a[href],button,input,select,textarea,summary,[role=button],[role=link],\
         [role=textbox],[role=checkbox],[role=tab],[contenteditable=\"true\"]');\
         for(let i=0;i<seen.length&&out.length<{limit};i++){{const e=seen[i];\
         const r=e.getBoundingClientRect();\
         const name=(e.getAttribute('aria-label')||e.innerText||e.value||\
         e.getAttribute('placeholder')||e.getAttribute('title')||'').trim().slice(0,200);\
         out.push({{index:i,\
         role:(e.getAttribute('role')||e.tagName).toLowerCase(),\
         name,value:typeof e.value==='string'?e.value.slice(0,200):'',\
         x:r.x,y:r.y,width:r.width,height:r.height,\
         visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'}});}}\
         return out}})()"
    )
}

/// The `index`-th element of the same query [`elements`] uses, addressed the
/// same way, so a reference resolves to what the read reported.
pub fn element_rect(index: usize) -> String {
    format!(
        "(()=>{{const seen=document.querySelectorAll(\
         'a[href],button,input,select,textarea,summary,[role=button],[role=link],\
         [role=textbox],[role=checkbox],[role=tab],[contenteditable=\"true\"]');\
         const e=seen[{index}];if(!e)return null;const r=e.getBoundingClientRect();\
         return {{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,\
         visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'}}}})()"
    )
}

/// Focus (and optionally clear) the `index`-th interactive element.
pub fn focus_element(index: usize, replace: bool) -> String {
    format!(
        "(()=>{{const seen=document.querySelectorAll(\
         'a[href],button,input,select,textarea,summary,[role=button],[role=link],\
         [role=textbox],[role=checkbox],[role=tab],[contenteditable=\"true\"]');\
         const e=seen[{index}];if(!e)return false;e.focus();\
         if({replace} && ('value' in e)){{const p=Object.getPrototypeOf(e);\
         const d=Object.getOwnPropertyDescriptor(p,'value');\
         if(d&&d.set)d.set.call(e,'');else e.value='';\
         e.dispatchEvent(new Event('input',{{bubbles:true}}));}}\
         return true}})()"
    )
}

pub fn links(limit: usize) -> String {
    format!(
        "(()=>{{const out=[];const seen=document.querySelectorAll('a[href]');\
         for(let i=0;i<seen.length&&out.length<{limit};i++){{const e=seen[i];\
         const r=e.getBoundingClientRect();\
         out.push({{index:i,role:'link',name:(e.innerText||e.getAttribute('aria-label')||'')\
         .trim().slice(0,200),value:e.href.slice(0,2000),\
         x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0}});}}\
         return out}})()"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selector_cannot_escape_its_string_literal() {
        // The classic break-out attempt plus a line terminator: both have to
        // come back as escapes inside one literal.
        let hostile = "\");globalThis.stolen=1;(\"\n";
        let quoted = quote(hostile);
        assert!(quoted.starts_with('"') && quoted.ends_with('"'));
        // Every inner quote is escaped, so the literal cannot be closed early.
        let inner = &quoted.as_bytes()[1..quoted.len() - 1];
        for (index, byte) in inner.iter().enumerate() {
            if *byte == b'"' {
                assert!(
                    index > 0 && inner[index - 1] == b'\\',
                    "bare quote at {index}"
                );
            }
        }
        // And no raw line terminator, which would end the statement instead.
        assert!(!quoted.contains('\n') && !quoted.contains('\r'));
        // And it survives round-tripping, so a legitimate odd selector still
        // reaches the page unchanged.
        assert_eq!(serde_json::from_str::<String>(&quoted).unwrap(), hostile);
        assert!(rect_of(hostile).contains(&quoted));
        assert!(exists(hostile).contains(&quoted));
    }

    #[test]
    fn helper_scripts_carry_their_bounds() {
        assert!(elements(25).contains("out.length<25"));
        assert!(links(7).contains("out.length<7"));
        assert!(element_rect(3).contains("seen[3]"));
        assert!(focus_element(3, true).contains("seen[3]"));
        assert!(focus_field("#a", false).contains("false &&"));
    }
}
