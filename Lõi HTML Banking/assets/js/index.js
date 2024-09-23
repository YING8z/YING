
    /*-----------------------------------------------------------------
     Toastr
    -------------------------------------------------------------------*/        
    const notyf = new Notyf({
        position: {
          x: 'right',
          y: 'top',
        },
        duration: 3000,
        ripple: true,
        dismissible: true
      });
      function copyToClipboard(element) {
        var copyText = element.getAttribute("data-copy");
        var textarea = document.createElement("textarea");
        textarea.value = copyText;
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, 99999);
        document.execCommand('copy');
        document.body.removeChild(textarea);
        notyf.success("Đã sao chép: "+ copyText);
    }