jQuery(document).ready(function($) {
    // DOM Elements
    const bookNowBtn = $('#bookNowBtn');
    const bookBarberButtons = $('.book-barber');
    const appointmentForm = $('#appointmentForm');
    const barberSelect = $('#barberSelect');
    
    // Scroll to appointment section
    bookNowBtn.on('click', function() {
        $('html, body').animate({
            scrollTop: $('#appointment').offset().top - 100
        }, 500);
    });
    
    // Book specific barber
    bookBarberButtons.each(function() {
        $(this).on('click', function() {
            const barberName = $(this).data('barber');
            barberSelect.val(barberName);
            $('html, body').animate({
                scrollTop: $('#appointment').offset().top - 100
            }, 500);
        });
    });
    
    // Set minimum date for appointment to today
    const today = new Date().toISOString().split('T')[0];
    $('#appointmentDate').attr('min', today);
    
    // Handle appointment form submission with AJAX
    appointmentForm.on('submit', function(e) {
        e.preventDefault();
        
        const barber = $('#barberSelect').val();
        const service = $('#serviceSelect').val();
        const date = $('#appointmentDate').val();
        const time = $('#appointmentTime').val();
        const name = $('#customerName').val();
        const phone = $('#customerPhone').val();
        const messageDiv = $('#appointmentMessage');
        
        if (!barber || !service || !date || !time || !name || !phone) {
            messageDiv.html('<p style="color: red; text-align: center;">Please fill in all fields</p>').show();
            return;
        }
        
        // Show loading message
        messageDiv.html('<p style="color: #666; text-align: center;">Booking your appointment...</p>').show();
        
        // AJAX request
        $.ajax({
            url: elitecuts_ajax.ajax_url,
            type: 'POST',
            data: {
                action: 'book_appointment',
                nonce: elitecuts_ajax.nonce,
                barber: barber,
                service: service,
                date: date,
                time: time,
                name: name,
                phone: phone
            },
            success: function(response) {
                if (response.success) {
                    messageDiv.html('<p style="color: green; text-align: center;">' + response.data.message + '</p>').show();
                    appointmentForm[0].reset();
                    
                    // Hide success message after 5 seconds
                    setTimeout(function() {
                        messageDiv.fadeOut();
                    }, 5000);
                } else {
                    messageDiv.html('<p style="color: red; text-align: center;">' + response.data.message + '</p>').show();
                }
            },
            error: function() {
                messageDiv.html('<p style="color: red; text-align: center;">An error occurred. Please try again.</p>').show();
            }
        });
    });
    
    // Smooth scrolling for navigation links
    $('a[href*="#"]').on('click', function(e) {
        const target = $(this).attr('href');
        
        // Only handle anchor links on the same page
        if (target.indexOf('#') !== -1) {
            const hash = target.substring(target.indexOf('#'));
            
            if ($(hash).length) {
                e.preventDefault();
                $('html, body').animate({
                    scrollTop: $(hash).offset().top - 100
                }, 500);
            }
        }
    });
});
