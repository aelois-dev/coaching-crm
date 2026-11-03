(function () {
  var C = window.CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var form = $("enquiry"), btn = $("submit"), errBox = $("formError");

  if (C.businessName) { document.title = C.businessName + " - running coaching enquiry"; $("brandName").textContent = C.businessName; $("brandName").classList.remove("hidden"); }
  if (C.tagline) $("tagline").textContent = C.tagline;
  if (C.aboutCoaches) { $("aboutText").textContent = C.aboutCoaches; $("aboutSec").classList.remove("hidden"); }
  if (C.reviews && C.reviews.length) {
    C.reviews.forEach(function (r) {
      if (!r || !r.text) return;
      var q = document.createElement("blockquote"); q.textContent = r.text;
      if (r.name) { var c = document.createElement("cite"); c.textContent = r.name; q.appendChild(c); }
      $("reviewsList").appendChild(q);
    });
    if ($("reviewsList").children.length) $("reviewsSec").classList.remove("hidden");
  }
  if (API.demo) $("demoBanner").classList.remove("hidden");

  var src = (new URLSearchParams(location.search).get("src") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);

  var MESSAGES = {
    invalid: "Some details look wrong. Please check the form and try again.",
    consent_required: "Please tick the box so we are allowed to contact you.",
    rate_limited: "Too many enquiries from this device. Please wait a few minutes and try again.",
    spam: "Sorry, we could not accept this enquiry.",
    network: "We could not reach the server. Check your internet connection and try again."
  };

  function setInvalid(id, bad) {
    var f = $(id).closest(".field");
    f.classList.toggle("invalid", bad);
    $(id).setAttribute("aria-invalid", bad ? "true" : "false");
  }
  function validate() {
    var v = {
      name: $("name").value.trim(), phone: $("phone").value.trim(), email: $("email").value.trim(),
      age: $("age").value.trim(), goal: $("goal").value, level: $("level").value,
      area: $("area").value.trim(), times: $("times").value.trim()
    };
    var bad = {
      name: !v.name,
      phone: v.phone.replace(/\D/g, "").length < 8 || v.phone.replace(/\D/g, "").length > 15,
      email: !!v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email),
      age: !(+v.age >= 5 && +v.age <= 100),
      goal: !v.goal, level: !v.level, area: !v.area, times: !v.times,
      consent: !$("consent").checked
    };
    var first = null;
    ["name", "phone", "email", "age", "goal", "level", "area", "times", "consent"].forEach(function (k) {
      setInvalid(k, bad[k]); if (bad[k] && !first) first = k;
    });
    return first;
  }
  ["name", "phone", "email", "age", "goal", "level", "area", "times", "consent"].forEach(function (k) {
    $(k).addEventListener("input", function () { if ($(k).closest(".field").classList.contains("invalid")) validate(); });
    $(k).addEventListener("change", function () { if ($(k).closest(".field").classList.contains("invalid")) validate(); });
  });

  function showError(text) {
    errBox.textContent = text; errBox.classList.remove("hidden"); errBox.focus();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errBox.classList.add("hidden");
    var first = validate();
    if (first) { showError("Please fix the highlighted fields below."); $(first).focus(); return; }
    var body = {
      name: $("name").value.trim(), phone: $("phone").value.trim(), email: $("email").value.trim(),
      age: $("age").value.trim(), goal: $("goal").value, level: $("level").value,
      area: $("area").value.trim(), times: $("times").value.trim(),
      consent: true, website: $("website").value
    };
    if (src) body.src = src;
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    var label = btn.textContent; btn.textContent = "Sending...";
    API.post("addLead", body).then(function (r) {
      if (r && r.ok) {
        $("promise").textContent = C.replyPromise || "soon";
        $("formCard").classList.add("hidden"); $("thanks").classList.remove("hidden"); $("thanks").focus();
        $("thanks").scrollIntoView({ block: "start" });
        form.reset();
      } else {
        showError(MESSAGES[r && r.error] || "Something went wrong. Please try again.");
      }
    }).catch(function () { showError(MESSAGES.network); })
      .then(function () { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = label === "Sending..." ? "Send my enquiry" : label; });
  });

  $("again").addEventListener("click", function () {
    $("thanks").classList.add("hidden"); $("formCard").classList.remove("hidden"); $("name").focus();
  });

  /* Look and feel only: scroll-reveal and the sticky mobile bar. Never touches the form logic. */
  (function () {
    if (!("IntersectionObserver" in window)) return;
    var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm) {
      var items = document.querySelectorAll(".rv");
      document.documentElement.classList.add("js-rv");
      var rio = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); } });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      items.forEach(function (el, i) { el.style.transitionDelay = (i % 3) * 80 + "ms"; rio.observe(el); });
    }
    var bar = $("stickyBar"), cta = $("stickyCta");
    var heroOn = true, formOn = false;
    function sync() {
      var show = !heroOn && !formOn;
      bar.classList.toggle("show", show);
      bar.setAttribute("aria-hidden", show ? "false" : "true");
      cta.setAttribute("tabindex", show ? "0" : "-1");
    }
    var sio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.target.id === "heroCta") heroOn = e.isIntersecting;
        else formOn = e.isIntersecting;
      });
      sync();
    });
    sio.observe($("heroCta")); sio.observe($("enquire"));
  })();
})();
