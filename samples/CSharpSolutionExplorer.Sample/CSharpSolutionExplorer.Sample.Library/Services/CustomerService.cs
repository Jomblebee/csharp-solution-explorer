using CSharpSolutionExplorer.Sample.Library.Models;

namespace CSharpSolutionExplorer.Sample.Library.Services;

public class CustomerService
{
    private readonly List<Customer> _customers = [];

    public void AddCustomer(Customer customer)
    {
        _customers.Add(customer);
    }

    public Customer? GetCustomer(int id)
    {
        return _customers.FirstOrDefault(c => c.Id == id);
    }

    public List<Customer> GetAllCustomers()
    {
        return [.._customers];
    }
}
