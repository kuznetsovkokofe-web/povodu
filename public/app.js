const MACHINE_IDS = ["31613", "31994", "32027", "393"];
const views = [
  "home-view",
  "machine-list-view",
  "machine-view",
  "loyalty-view",
  "loyalty-success-view",
  "review-view"
];

let selectedMachine = null;

const $ = (id) => document.getElementById(id);

function showView(id) {
  views.forEach((viewId) => {
    $(viewId).classList.toggle("hidden", viewId !== id);
  });

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

  if (updateUrl) {
    history.pushState(
      { view: "machine", id: selectedMachine },
      "",
      machineUrl(selectedMachine)
    );
  }

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

const loyaltyForm = $("loyalty-form");

loyaltyForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = $("card-form-message");
  const submit = $("card-submit");

  message.textContent = "Надсилаємо замовлення…";
  submit.disabled = true;

  const formData = new FormData(loyaltyForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch("/api/card-orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "Не вдалося оформити замовлення."
      );
    }

    $("success-first-name").textContent = result.firstName;
    $("success-order-number").textContent = result.orderNumber;

    history.pushState(
      { view: "loyalty-success" },
      "",
      "/loyalty/success"
    );

    showView("loyalty-success-view");
    loyaltyForm.reset();
  } catch (error) {
    message.textContent =
      error.message ||
      "Помилка з’єднання. Перевірте інтернет і спробуйте ще раз.";
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll("[data-home]").forEach((button) => {
  button.addEventListener("click", home);
});

$("minus-liter").addEventListener("click", () => {
  $("liters").value = Math.max(
    1,
    (Number($("liters").value) || 1) - 1
  );
});

$("plus-liter").addEventListener("click", () => {
  $("liters").value = Math.min(
    100,
    (Number($("liters").value) || 1) + 1
  );
});

$("continue-button").addEventListener("click", async () => {
  const liters = Number($("liters").value);
  const message = $("order-message");
  const button = $("continue-button");

  if (!selectedMachine) {
    message.textContent = "Спочатку оберіть водомат.";
    return;
  }

  if (!Number.isInteger(liters) || liters < 1 || liters > 100) {
    message.textContent =
      "Вкажіть цілу кількість літрів від 1 до 100.";
    return;
  }

  const selectedWater = document.querySelector(
    'input[name="waterType"]:checked'
  );

  if (!selectedWater) {
    message.textContent = "Оберіть тип води.";
    return;
  }

  const typeId = selectedWater.value === "purified" ? 1 : 2;

  button.disabled = true;
  message.textContent = "Створюємо рахунок для оплати…";

  try {
    const response = await fetch("/api/payments/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        machineId: selectedMachine,
        typeId,
        liters
      })
    });

    const result = await response.json();

    if (!response.ok || !result.pageUrl) {
      throw new Error(
        result.error || "Не вдалося створити рахунок для оплати."
      );
    }

    message.textContent = "Переходимо до оплати…";
    window.location.assign(result.pageUrl);
  } catch (error) {
    message.textContent =
      error.message || "Помилка з’єднання. Спробуйте ще раз.";

    button.disabled = false;
  }
});

$("edit-order").addEventListener("click", () => {
  openMachine(selectedMachine, false);
});

$("finish-demo").addEventListener("click", home);

window.addEventListener("popstate", () => routeFromUrl(false));

function routeFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/^\/machine\/([^/]+)\/?$/);

  if (match) {
    return openMachine(decodeURIComponent(match[1]), false);
  }

  if (path === "/machines") {
    return showView("machine-list-view");
  }

  if (path === "/loyalty") {
    return showView("loyalty-view");
  }

  if (path === "/loyalty/success") {
    return showView("loyalty-success-view");
  }

  if (path.startsWith("/order/")) {
    const id = path.split("/")[2];

    if (MACHINE_IDS.includes(id)) {
      return openMachine(id, false);
    }
  }

  showView("home-view");
}

routeFromUrl();
