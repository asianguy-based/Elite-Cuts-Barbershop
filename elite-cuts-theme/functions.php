<?php
/**
 * Elite Cuts Barbershop Theme Functions
 */

// Theme Setup
function elitecuts_theme_setup() {
    // Add theme support
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', array('search-form', 'comment-form', 'comment-list', 'gallery', 'caption'));
    add_theme_support('custom-logo');
    
    // Register navigation menus
    register_nav_menus(array(
        'primary' => __('Primary Menu', 'elitecuts'),
        'footer' => __('Footer Menu', 'elitecuts'),
    ));
}
add_action('after_setup_theme', 'elitecuts_theme_setup');

// Enqueue styles and scripts
function elitecuts_enqueue_scripts() {
    // Enqueue main stylesheet
    wp_enqueue_style('elitecuts-style', get_stylesheet_uri(), array(), '1.0');
    
    // Enqueue Font Awesome
    wp_enqueue_style('font-awesome', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css', array(), '6.4.0');
    
    // Enqueue custom JavaScript
    wp_enqueue_script('elitecuts-script', get_template_directory_uri() . '/js/main.js', array('jquery'), '1.0', true);
    
    // Localize script for AJAX
    wp_localize_script('elitecuts-script', 'elitecuts_ajax', array(
        'ajax_url' => admin_url('admin-ajax.php'),
        'nonce' => wp_create_nonce('elitecuts_nonce')
    ));
}
add_action('wp_enqueue_scripts', 'elitecuts_enqueue_scripts');

// Register Custom Post Type: Barbers
function elitecuts_register_barber_post_type() {
    $labels = array(
        'name' => 'Barbers',
        'singular_name' => 'Barber',
        'menu_name' => 'Barbers',
        'add_new' => 'Add New Barber',
        'add_new_item' => 'Add New Barber',
        'edit_item' => 'Edit Barber',
        'new_item' => 'New Barber',
        'view_item' => 'View Barber',
        'search_items' => 'Search Barbers',
        'not_found' => 'No barbers found',
        'not_found_in_trash' => 'No barbers found in trash'
    );
    
    $args = array(
        'labels' => $labels,
        'public' => true,
        'has_archive' => true,
        'menu_icon' => 'dashicons-admin-users',
        'supports' => array('title', 'editor', 'thumbnail'),
        'rewrite' => array('slug' => 'barbers'),
        'show_in_rest' => true,
    );
    
    register_post_type('barber', $args);
}
add_action('init', 'elitecuts_register_barber_post_type');

// Register Custom Post Type: Services
function elitecuts_register_service_post_type() {
    $labels = array(
        'name' => 'Services',
        'singular_name' => 'Service',
        'menu_name' => 'Services',
        'add_new' => 'Add New Service',
        'add_new_item' => 'Add New Service',
        'edit_item' => 'Edit Service',
        'new_item' => 'New Service',
        'view_item' => 'View Service',
        'search_items' => 'Search Services',
        'not_found' => 'No services found',
        'not_found_in_trash' => 'No services found in trash'
    );
    
    $args = array(
        'labels' => $labels,
        'public' => true,
        'has_archive' => true,
        'menu_icon' => 'dashicons-scissors',
        'supports' => array('title', 'editor', 'thumbnail'),
        'rewrite' => array('slug' => 'services'),
        'show_in_rest' => true,
    );
    
    register_post_type('service', $args);
}
add_action('init', 'elitecuts_register_service_post_type');

// Register Custom Post Type: Appointments
function elitecuts_register_appointment_post_type() {
    $labels = array(
        'name' => 'Appointments',
        'singular_name' => 'Appointment',
        'menu_name' => 'Appointments',
        'add_new' => 'Add New Appointment',
        'edit_item' => 'Edit Appointment',
        'view_item' => 'View Appointment',
        'search_items' => 'Search Appointments',
    );
    
    $args = array(
        'labels' => $labels,
        'public' => false,
        'show_ui' => true,
        'capability_type' => 'post',
        'menu_icon' => 'dashicons-calendar-alt',
        'supports' => array('title'),
        'show_in_rest' => false,
    );
    
    register_post_type('appointment', $args);
}
add_action('init', 'elitecuts_register_appointment_post_type');

// Add custom meta boxes for Barbers
function elitecuts_add_barber_meta_boxes() {
    add_meta_box(
        'barber_details',
        'Barber Details',
        'elitecuts_barber_details_callback',
        'barber',
        'normal',
        'high'
    );
}
add_action('add_meta_boxes', 'elitecuts_add_barber_meta_boxes');

function elitecuts_barber_details_callback($post) {
    wp_nonce_field('elitecuts_save_barber_details', 'elitecuts_barber_nonce');
    
    $experience = get_post_meta($post->ID, '_barber_experience', true);
    $specialties = get_post_meta($post->ID, '_barber_specialties', true);
    
    echo '<p><label for="barber_experience">Years of Experience:</label><br>';
    echo '<input type="text" id="barber_experience" name="barber_experience" value="' . esc_attr($experience) . '" style="width:100%;" /></p>';
    
    echo '<p><label for="barber_specialties">Specialties (comma-separated):</label><br>';
    echo '<input type="text" id="barber_specialties" name="barber_specialties" value="' . esc_attr($specialties) . '" style="width:100%;" placeholder="Fades, Beard Trims, Classic Cuts" /></p>';
}

function elitecuts_save_barber_details($post_id) {
    if (!isset($_POST['elitecuts_barber_nonce']) || !wp_verify_nonce($_POST['elitecuts_barber_nonce'], 'elitecuts_save_barber_details')) {
        return;
    }
    
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
        return;
    }
    
    if (isset($_POST['barber_experience'])) {
        update_post_meta($post_id, '_barber_experience', sanitize_text_field($_POST['barber_experience']));
    }
    
    if (isset($_POST['barber_specialties'])) {
        update_post_meta($post_id, '_barber_specialties', sanitize_text_field($_POST['barber_specialties']));
    }
}
add_action('save_post', 'elitecuts_save_barber_details');

// Add custom meta boxes for Services
function elitecuts_add_service_meta_boxes() {
    add_meta_box(
        'service_details',
        'Service Details',
        'elitecuts_service_details_callback',
        'service',
        'normal',
        'high'
    );
}
add_action('add_meta_boxes', 'elitecuts_add_service_meta_boxes');

function elitecuts_service_details_callback($post) {
    wp_nonce_field('elitecuts_save_service_details', 'elitecuts_service_nonce');
    
    $price = get_post_meta($post->ID, '_service_price', true);
    $icon = get_post_meta($post->ID, '_service_icon', true);
    
    echo '<p><label for="service_price">Price ($):</label><br>';
    echo '<input type="number" id="service_price" name="service_price" value="' . esc_attr($price) . '" style="width:100%;" /></p>';
    
    echo '<p><label for="service_icon">Font Awesome Icon Class:</label><br>';
    echo '<input type="text" id="service_icon" name="service_icon" value="' . esc_attr($icon) . '" style="width:100%;" placeholder="fas fa-cut" /></p>';
    echo '<small>Enter Font Awesome icon class (e.g., fas fa-cut, fas fa-user-tie, fas fa-spa)</small>';
}

function elitecuts_save_service_details($post_id) {
    if (!isset($_POST['elitecuts_service_nonce']) || !wp_verify_nonce($_POST['elitecuts_service_nonce'], 'elitecuts_save_service_details')) {
        return;
    }
    
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
        return;
    }
    
    if (isset($_POST['service_price'])) {
        update_post_meta($post_id, '_service_price', sanitize_text_field($_POST['service_price']));
    }
    
    if (isset($_POST['service_icon'])) {
        update_post_meta($post_id, '_service_icon', sanitize_text_field($_POST['service_icon']));
    }
}
add_action('save_post', 'elitecuts_save_service_details');

// AJAX handler for appointment booking
function elitecuts_handle_appointment_booking() {
    check_ajax_referer('elitecuts_nonce', 'nonce');
    
    $barber = sanitize_text_field($_POST['barber']);
    $service = sanitize_text_field($_POST['service']);
    $date = sanitize_text_field($_POST['date']);
    $time = sanitize_text_field($_POST['time']);
    $name = sanitize_text_field($_POST['name']);
    $phone = sanitize_text_field($_POST['phone']);
    
    // Create appointment post
    $appointment_data = array(
        'post_title' => $name . ' - ' . $date . ' ' . $time,
        'post_type' => 'appointment',
        'post_status' => 'publish',
    );
    
    $appointment_id = wp_insert_post($appointment_data);
    
    if ($appointment_id) {
        update_post_meta($appointment_id, '_appointment_barber', $barber);
        update_post_meta($appointment_id, '_appointment_service', $service);
        update_post_meta($appointment_id, '_appointment_date', $date);
        update_post_meta($appointment_id, '_appointment_time', $time);
        update_post_meta($appointment_id, '_appointment_customer_name', $name);
        update_post_meta($appointment_id, '_appointment_customer_phone', $phone);
        
        wp_send_json_success(array('message' => 'Appointment booked successfully!'));
    } else {
        wp_send_json_error(array('message' => 'Failed to book appointment.'));
    }
}
add_action('wp_ajax_book_appointment', 'elitecuts_handle_appointment_booking');
add_action('wp_ajax_nopriv_book_appointment', 'elitecuts_handle_appointment_booking');

// Widget areas
function elitecuts_widgets_init() {
    register_sidebar(array(
        'name' => __('Footer Widget Area', 'elitecuts'),
        'id' => 'footer-widget-area',
        'description' => __('Widget area for footer', 'elitecuts'),
        'before_widget' => '<div class="footer-widget">',
        'after_widget' => '</div>',
        'before_title' => '<h3>',
        'after_title' => '</h3>',
    ));
}
add_action('widgets_init', 'elitecuts_widgets_init');

// Customizer settings
function elitecuts_customize_register($wp_customize) {
    // Contact Information Section
    $wp_customize->add_section('elitecuts_contact_info', array(
        'title' => __('Contact Information', 'elitecuts'),
        'priority' => 30,
    ));
    
    // Phone
    $wp_customize->add_setting('elitecuts_phone', array(
        'default' => '(555) 123-4567',
        'sanitize_callback' => 'sanitize_text_field',
    ));
    
    $wp_customize->add_control('elitecuts_phone', array(
        'label' => __('Phone Number', 'elitecuts'),
        'section' => 'elitecuts_contact_info',
        'type' => 'text',
    ));
    
    // Email
    $wp_customize->add_setting('elitecuts_email', array(
        'default' => 'info@elitecuts.com',
        'sanitize_callback' => 'sanitize_email',
    ));
    
    $wp_customize->add_control('elitecuts_email', array(
        'label' => __('Email Address', 'elitecuts'),
        'section' => 'elitecuts_contact_info',
        'type' => 'email',
    ));
    
    // Address
    $wp_customize->add_setting('elitecuts_address', array(
        'default' => '123 Barber Street, City',
        'sanitize_callback' => 'sanitize_text_field',
    ));
    
    $wp_customize->add_control('elitecuts_address', array(
        'label' => __('Address', 'elitecuts'),
        'section' => 'elitecuts_contact_info',
        'type' => 'text',
    ));
    
    // Hours
    $wp_customize->add_setting('elitecuts_hours', array(
        'default' => 'Mon-Sat: 9AM-7PM, Sun: 10AM-5PM',
        'sanitize_callback' => 'sanitize_text_field',
    ));
    
    $wp_customize->add_control('elitecuts_hours', array(
        'label' => __('Business Hours', 'elitecuts'),
        'section' => 'elitecuts_contact_info',
        'type' => 'text',
    ));
    
    // Social Media Section
    $wp_customize->add_section('elitecuts_social_media', array(
        'title' => __('Social Media', 'elitecuts'),
        'priority' => 31,
    ));
    
    $social_networks = array('facebook', 'instagram', 'twitter', 'tiktok');
    
    foreach ($social_networks as $network) {
        $wp_customize->add_setting('elitecuts_' . $network, array(
            'default' => '',
            'sanitize_callback' => 'esc_url_raw',
        ));
        
        $wp_customize->add_control('elitecuts_' . $network, array(
            'label' => ucfirst($network) . ' URL',
            'section' => 'elitecuts_social_media',
            'type' => 'url',
        ));
    }
}
add_action('customize_register', 'elitecuts_customize_register');
