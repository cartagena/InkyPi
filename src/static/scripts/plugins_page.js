// Plugins page: disable/enable a plugin from its catalog tile.
(function () {
  "use strict";

  async function togglePlugin(button) {
    const pluginId = button.dataset.pluginId;
    const pluginName = button.dataset.pluginName || pluginId;
    const action = button.dataset.pluginToggle; // "disable" | "enable"
    if (!pluginId || !action) return;

    button.disabled = true;
    try {
      const resp = await fetch(`/plugin/${encodeURIComponent(pluginId)}/${action}`, {
        method: "POST",
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `Failed to ${action} plugin`);
      }
      if (typeof showToast === "function") {
        const past = action === "disable" ? "disabled" : "enabled";
        showToast("success", `${pluginName} ${past}.`);
      }
      window.location.reload();
    } catch (err) {
      button.disabled = false;
      if (typeof showToast === "function") {
        showToast("error", err.message || `Failed to ${action} plugin.`);
      } else {
        console.error(err);
      }
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-plugin-toggle]");
    if (button) togglePlugin(button);
  });
})();
