const MACHINE_IDS = ["31613", "31994", "32027", "393"];
const views = ["home-view", "machine-list-view", "machine-view", "loyalty-view", "review-view"];
let selectedMachine = null;

const $ = (id) => document.getElementById(id);
function showView(id) {
  views.forEach((viewId) => $(viewId).classList.toggle("hidden", viewId !== id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function machineUrl(id) {
  return `/machine/${encodeURIComponent(id)}`;
}
function openMachine(id, updateUrl = true) {
  if (!MACHINE_IDS.includes(String(id))) {
    selectedMachine = null;
    showView("machine-list-view");
    return;
  }
  selectedMachine = String(id);
  $("machine-number").textContent = selectedMachine;
  if (updateUrl) history.pushState({ view: "machine", id: selectedMachine }, "", machineUrl(selectedMachine));
  showView("machine-view");
}
function renderMachineList() {
  const list = $("machine-list");
  list.replaceChildren();
  MACHINE_IDS.forEach((id) => {
    const button = document.createElement("button");
    button.className = "machine-item";
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = `Водомат № ${id}`;
    const arrow = document.createElement("span");
    arrow.textContent = "›";
    button.append(label, arrow);
    button.addEventListener("click", () => openMachine(id));
    list.append(button);
  });
}
function home() {
  selectedMachine = null;
  history.pushState({ view: "home" }, "", "/");
  showView("home-view");
}
$("year").textContent = new Date().getFullYear();
renderMachineList();
$("start-water").addEventListener("click", () => {
  history.pushState({ view: "machines" }, "", "/machines");
  showView("machine-list-view");
});
$("loyalty-button").addEventListener("click", () => {
  history.pushState({ view: "loyalty" }, "", "/loyalty");
  showView("loyalty-view");
});
document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", home));
$("minus-liter").addEventListener("click", () => {
  $("liters").value = Math.max(1, (Number($("liters").value) || 1) - 1);
});
$("plus-liter").addEventListener("click", () => {
  $("liters").value = Math.min(100, (Number($("liters").value) || 1) + 1);
});
$("continue-button").addEventListener("click", () => {
  const liters = Number($("liters").value);
  if (!selectedMachine) {
    $("order-message").textContent = "Спочатку оберіть водомат.";
    return;
  }
  if (!Number.isInteger(liters) || liters < 1 || liters > 100) {
    $("order-message").textContent = "Вкажіть цілу кількість літрів від 1 до 100.";
    return;
  }
  const water = document.querySelector('input[name="waterType"]:checked').value;
  $("review-machine").textContent = selectedMachine;
  $("review-water").textContent = water === "purified" ? "Очищена вода" : "Мінералізована вода";
  $("review-liters").textContent = `${liters} л`;
  history.pushState({ view: "review", id: selectedMachine }, "", `/order/${selectedMachine}`);
  showView("review-view");
});
$("edit-order").addEventListener("click", () => openMachine(selectedMachine, false));
$("finish-demo").addEventListener("click", home);
window.addEventListener("popstate", () => routeFromUrl(false));
function routeFromUrl(updateUrl = true) {
  const path = window.location.pathname;
  const match = path.match(/^\/machine\/([^/]+)\/?$/);
  if (match) return openMachine(decodeURIComponent(match[1]), false);
  if (path === "/machines") return showView("machine-list-view");
  if (path === "/loyalty") return showView("loyalty-view");
  if (path.startsWith("/order/")) {
    const id = path.split("/")[2];
    if (MACHINE_IDS.includes(id)) return openMachine(id, false);
  }
  showView("home-view");
}
routeFromUrl();
