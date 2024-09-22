document.addEventListener("DOMContentLoaded", function() {
    const snowflakesCount = 150;
    const snowContainer = document.getElementById("snow");
    const characters = "❄";

    for (let i = 0; i < snowflakesCount; i++) {
        let snowflake = document.createElement("div");
        snowflake.className = "snowflake";
        snowflake.innerText = characters[Math.floor(Math.random() * characters.length)];
        snowflake.style.fontSize = Math.random() * 20 + 10 + "px";
        snowflake.style.left = Math.random() * 100 + "vw";
        snowflake.style.animationDuration = Math.random() * 20 + 10 + "s";
        snowflake.style.opacity = Math.random() * 0.5 + 0.5;

        snowContainer.appendChild(snowflake);
    }

    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes fall {
            0% { transform: translateY(-100vh); }
            100% { transform: translateY(100vh); }
        }
        .snowflake {
            animation: fall linear infinite;
        }
    `;
    document.head.appendChild(style);
});