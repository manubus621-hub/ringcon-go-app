document.addEventListener("DOMContentLoaded", () => {
    // Busca todos los botones y enlaces para que no recarguen la página
    const botones = document.querySelectorAll("button, .btn, a[href='#']");
    
    botones.forEach(boton => {
        boton.addEventListener("click", (e) => {
            // Esto evita que la página vuelva arriba al hacer clic
            e.preventDefault(); 
            
            console.log("¡Botón tocado sin saltar arriba!");
        });
    });
});
